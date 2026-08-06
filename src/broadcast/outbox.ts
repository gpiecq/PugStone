// Worker d'émission : maintient les messages publiés cohérents avec l'état
// courant des annonces sur tous les serveurs du réseau. Chaque `EventMessage`
// porte un `syncedVersion` comparé au compteur de l'annonce (`publicVersion`
// pour `kind = PUBLIC`, `dashboardVersion` pour `kind = DASHBOARD`) ; ce
// worker sélectionne les lignes en retard, régénère le rendu depuis l'état
// courant, envoie ou édite, puis écrit `syncedVersion`. Trois propriétés en
// découlent :
//  - idempotence : rejouer un tick qui n'a rien à faire ne produit aucun appel ;
//  - coalescence : plusieurs incréments de version rapprochés ne produisent
//    qu'une seule édition, puisqu'on écrit toujours la version *courante* lue
//    au moment du traitement, jamais un simple +1 ;
//  - convergence : un serveur injoignable rattrape son retard tout seul au
//    prochain tick où sa cible redevient valide, sans intervention humaine.
import pLimit from 'p-limit'
import type { EventMessage } from '@prisma/client'
import type { Db } from '../db/client.js'
import type { EmojiMap } from '../config/emojis.js'
import { classifyDiscordError, type DiscordGateway, type MessagePayload } from './gateway.js'
import { renderDashboardMessage, renderPublicMessage } from './render.js'
import { loadEventView } from '../domain/events.js'
import { markGuildNeedsAttention } from '../domain/network.js'

export const MAX_ATTEMPTS = 8
const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 30 * 60 * 1000
// Durée pendant laquelle une ligne réclamée par un tick est protégée d'un
// second claim : le temps de traiter l'appel Discord + l'écriture finale.
// Si le process meurt entre les deux, le bail expire et un tick ultérieur
// reprend la ligne — c'est le mécanisme de survie au crash.
const CLAIM_LEASE_MS = 5 * 60 * 1000

export interface OutboxDeps {
  db: Db
  gateway: DiscordGateway
  emojis: EmojiMap
  now: () => Date
  concurrency?: number
}

/**
 * Exponentiel plafonné, avec jitter pour éviter que toutes les cibles
 * réessaient ensemble. Le jitter n'ajoute jamais que du délai (multiplicateur
 * dans [1, 1.3[) : `backoffDelayMs(1)` doit toujours rester au moins égal à
 * `BASE_DELAY_MS`, jamais en dessous. Le plafond est appliqué après jitter,
 * pour que le délai final reste borné par `MAX_DELAY_MS` même à fort nombre
 * de tentatives.
 */
export function backoffDelayMs(attempts: number): number {
  const exponential = BASE_DELAY_MS * 2 ** (attempts - 1)
  const withJitter = exponential * (1 + Math.random() * 0.3)
  return Math.round(Math.min(Math.max(withJitter, BASE_DELAY_MS), MAX_DELAY_MS))
}

interface Pending extends EventMessage {
  targetVersion: number
}

/**
 * Sélectionne les lignes en retard et les réclame atomiquement.
 *
 * `FOR UPDATE OF m SKIP LOCKED` à lui seul ne protège que la durée de
 * l'instruction SELECT : hors transaction explicite, le verrou est relâché
 * dès que la requête retourne, avant même que le worker n'ait envoyé le
 * moindre message. Pour que deux ticks qui se chevauchent (Tâche 17 :
 * plusieurs instances, ou un tick lent encore actif quand le suivant se
 * déclenche) se partagent réellement le travail, on repousse `nextAttemptAt`
 * d'un bail *dans la même transaction*, pendant que le verrou est encore
 * tenu : un second SELECT concurrent ne verra plus ces lignes tant que le
 * bail n'a pas expiré.
 */
async function claimPending(db: Db, now: Date, limit: number): Promise<Pending[]> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Pending[]>`
      SELECT m.*, CASE WHEN m.kind = 'PUBLIC' THEN e."publicVersion" ELSE e."dashboardVersion" END AS "targetVersion"
      FROM "EventMessage" m
      JOIN "Event" e ON e.id = m."eventId"
      WHERE m.disabled = false
        AND m."nextAttemptAt" <= ${now}
        AND m."syncedVersion" < CASE WHEN m.kind = 'PUBLIC' THEN e."publicVersion" ELSE e."dashboardVersion" END
      ORDER BY m."nextAttemptAt" ASC, m.kind ASC, m.id ASC
      LIMIT ${limit}
      FOR UPDATE OF m SKIP LOCKED
    `
    if (rows.length > 0) {
      await tx.eventMessage.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
      })
    }
    return rows
  })
}

async function handleFailure(deps: OutboxDeps, row: Pending, error: unknown): Promise<void> {
  const kind = classifyDiscordError(error)
  const message = error instanceof Error ? error.message : String(error)

  if (kind === 'MESSAGE_GONE') {
    // Un modérateur a supprimé le message : republier reviendrait à passer outre.
    await deps.db.eventMessage.update({ where: { id: row.id }, data: { disabled: true, lastError: message } })
    return
  }
  if (kind === 'TARGET_UNUSABLE') {
    await deps.db.eventMessage.update({ where: { id: row.id }, data: { disabled: true, lastError: message } })
    // EventMessage.guildId porte le discordGuildId, alors que
    // markGuildNeedsAttention attend l'identifiant interne du Guild.
    const guild = await deps.db.guild.findUnique({ where: { discordGuildId: row.guildId } })
    if (guild) await markGuildNeedsAttention(deps.db, guild.id, message)
    return
  }

  const attempts = row.attempts + 1
  await deps.db.eventMessage.update({
    where: { id: row.id },
    data: {
      attempts,
      lastError: message,
      disabled: attempts >= MAX_ATTEMPTS,
      nextAttemptAt: new Date(deps.now().getTime() + backoffDelayMs(attempts)),
    },
  })
}

interface Delivered {
  channelId: string
  messageId: string
}

/**
 * La ligne DASHBOARD naît sans `channelId` : on tente d'abord le DM au Raid
 * Leader. Un DM fermé échoue avec le code Discord 50007 (« Cannot send
 * messages to this user »), que `classifyDiscordError` range en `TRANSIENT`
 * (ce n'est pas une cible réseau cassée : le salon LFG, lui, reste utilisable).
 * On ne peut donc pas distinguer "DM fermé" d'une simple erreur transitoire
 * par le seul code de classification — mais ce n'est pas nécessaire : dans
 * les deux cas, la bonne réaction est la même, se rabattre sur un thread
 * privé dans le salon LFG d'origine plutôt que d'échouer la ligne. Seule une
 * vraie cible inutilisable (`TARGET_UNUSABLE`, ex. le bot n'a plus accès au
 * serveur) ou l'absence de salon de repli doit remonter en échec classique.
 * Une fois basculée sur un thread, la ligne y reste définitivement : au tick
 * suivant, `messageId` et `channelId` sont déjà renseignés, donc on édite
 * directement sans retenter le DM.
 */
async function deliverDashboard(
  deps: OutboxDeps,
  row: Pending,
  payload: MessagePayload,
  authorId: string,
  lfgChannelId: string | null,
): Promise<Delivered> {
  if (row.messageId && row.channelId) {
    await deps.gateway.editMessage(row.channelId, row.messageId, payload)
    return { channelId: row.channelId, messageId: row.messageId }
  }
  try {
    return await deps.gateway.sendDM(authorId, payload)
  } catch (error) {
    if (classifyDiscordError(error) === 'TARGET_UNUSABLE' || !lfgChannelId) throw error
    const thread = await deps.gateway.createPrivateThread(lfgChannelId, 'PugStone dashboard', authorId)
    const sent = await deps.gateway.sendMessage(thread.channelId, payload)
    return { channelId: thread.channelId, messageId: sent.messageId }
  }
}

export async function runOutboxTick(deps: OutboxDeps): Promise<{ processed: number; failed: number }> {
  const now = deps.now()
  const rows = await claimPending(deps.db, now, 100)
  const limit = pLimit(deps.concurrency ?? 5)
  let processed = 0
  let failed = 0

  const process = (row: Pending) =>
    limit(async () => {
      try {
        const view = await loadEventView(deps.db, row.eventId)
        const payload =
          row.kind === 'PUBLIC' ? renderPublicMessage(view, deps.emojis) : renderDashboardMessage(view, deps.emojis)

        if (row.kind === 'DASHBOARD') {
          const origin = await deps.db.guild.findUnique({ where: { discordGuildId: row.guildId } })
          const delivered = await deliverDashboard(deps, row, payload, view.event.authorId, origin?.lfgChannelId ?? null)
          await deps.db.eventMessage.update({
            where: { id: row.id },
            data: {
              channelId: delivered.channelId,
              messageId: delivered.messageId,
              syncedVersion: row.targetVersion,
              attempts: 0,
              lastError: null,
              nextAttemptAt: now,
            },
          })
          await deps.db.event.update({
            where: { id: row.eventId },
            data: { dashboardChannelId: delivered.channelId, dashboardMessageId: delivered.messageId },
          })
        } else if (row.messageId) {
          await deps.gateway.editMessage(row.channelId, row.messageId, payload)
          await deps.db.eventMessage.update({
            where: { id: row.id },
            data: { syncedVersion: row.targetVersion, attempts: 0, lastError: null, nextAttemptAt: now },
          })
        } else {
          const sent = await deps.gateway.sendMessage(row.channelId, payload)
          await deps.db.eventMessage.update({
            where: { id: row.id },
            data: { messageId: sent.messageId, syncedVersion: row.targetVersion, attempts: 0, lastError: null, nextAttemptAt: now },
          })
        }
        processed += 1
      } catch (error) {
        failed += 1
        await handleFailure(deps, row, error)
      }
    })

  // Une seule passe, toutes catégories confondues : chaque ligne appelle
  // l'API Discord indépendamment des autres, il n'existe aucune raison
  // métier d'imposer un ordre entre dashboard et diffusion publique.
  await Promise.all(rows.map(process))

  return { processed, failed }
}
