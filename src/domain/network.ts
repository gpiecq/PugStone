import { randomBytes } from 'node:crypto'
import type { Guild } from '@prisma/client'
import type { Db } from '../db/client.js'
import { GuildNotOnboarded, InviteCodeUnusable } from './errors.js'

/** Base 32 sans caractères ambigus : un code se dicte à l'oral sans confusion. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateCode(): string {
  return [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('')
}

export async function createInviteCode(db: Db, ownerId: string): Promise<string> {
  const code = generateCode()
  await db.inviteCode.create({ data: { code, createdBy: ownerId } })
  return code
}

export async function revokeInviteCode(db: Db, code: string): Promise<void> {
  await db.inviteCode.updateMany({
    where: { code, usedByGuild: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export interface RedeemParams {
  code: string
  discordGuildId: string
  lfgChannelId: string
  recruiterRoleIds: string[]
  timezone: string
  // Nom affiché aux autres serveurs du réseau (Tâche 18). Optionnel : le
  // schéma retombe sur `""` si l'appelant ne le transmet pas.
  name?: string
}

export async function redeemInviteCode(db: Db, params: RedeemParams): Promise<Guild> {
  return db.$transaction(async (tx) => {
    // Verrou de ligne : deux serveurs qui soumettent le même code au même instant
    // sont sérialisés ici, le second constate que usedByGuild n'est plus null.
    const rows = await tx.$queryRaw<{ code: string; usedByGuild: string | null; revokedAt: Date | null }[]>`
      SELECT code, "usedByGuild", "revokedAt" FROM "InviteCode" WHERE code = ${params.code} FOR UPDATE
    `
    const invite = rows[0]
    if (!invite || invite.usedByGuild || invite.revokedAt) throw new InviteCodeUnusable()

    const guild = await tx.guild.create({
      data: {
        discordGuildId: params.discordGuildId,
        lfgChannelId: params.lfgChannelId,
        recruiterRoleIds: params.recruiterRoleIds,
        timezone: params.timezone,
        name: params.name ?? '',
        status: 'ACTIVE',
      },
    })
    await tx.inviteCode.update({
      where: { code: params.code },
      data: { usedByGuild: guild.id, usedAt: new Date() },
    })
    return guild
  })
}

export interface UpdateGuildParams {
  discordGuildId: string
  lfgChannelId?: string
  recruiterRoleIds?: string[]
  timezone?: string
  // Rejouer /set-lfm-channel est le seul chemin de rattrapage pour un serveur
  // inscrit avant la Tâche 18 : c'est ainsi qu'il obtient un nom affichable.
  name?: string
}

export async function updateGuildConfig(db: Db, params: UpdateGuildParams): Promise<Guild> {
  const { discordGuildId, ...changes } = params
  // Un serveur qui n'a jamais consommé de code d'invitation n'a pas de ligne
  // Guild : sans ce contrôle, Prisma lèverait une P2025 brute jusqu'à
  // l'utilisateur final plutôt que le message métier attendu.
  const existing = await db.guild.findUnique({ where: { discordGuildId } })
  if (!existing) throw new GuildNotOnboarded()
  return db.guild.update({
    where: { discordGuildId },
    // Reconfigurer un serveur le remet dans le circuit : c'est la façon dont un
    // admin corrige un salon supprimé sans repasser par un code d'invitation.
    data: { ...changes, status: 'ACTIVE', statusReason: null },
  })
}

export function listActiveGuilds(db: Db): Promise<Guild[]> {
  return db.guild.findMany({
    where: { status: 'ACTIVE', lfgChannelId: { not: null } },
    orderBy: { joinedAt: 'asc' },
  })
}

/**
 * Écriture conditionnelle plutôt que lecture puis écriture, avec deux
 * exigences qui ne peuvent pas se satisfaire par un simple `updateMany` :
 *  - le motif (`statusReason`) doit toujours être rafraîchi, y compris quand
 *    le serveur est déjà `NEEDS_ATTENTION` (sans quoi `/network status`
 *    afficherait indéfiniment la toute première cause, même si l'échec
 *    courant en est une autre) ;
 *  - la notification, elle, ne doit partir que sur *transition*, c'est-à-dire
 *    seulement si le serveur était `ACTIVE` juste avant cet appel — jamais
 *    depuis `SUSPENDED` (un serveur qui a retiré le bot ne doit pas recevoir
 *    une alerte sur son propre retrait) ni depuis `NEEDS_ATTENTION` (anti-spam).
 *
 * Le CTE `prev` verrouille la ligne (`FOR UPDATE`) et capture son statut
 * *avant* la mise à jour, dans la même instruction SQL que l'`UPDATE` qui
 * suit : lecture et écriture sont donc atomiques, sans fenêtre entre les deux
 * où un second appelant pourrait s'intercaler. Deux appels concurrents sur le
 * même `guildId` se sérialisent sur le verrou du CTE : le premier lit
 * `ACTIVE`, applique la transition, commit ; le second, débloqué ensuite,
 * relit alors `NEEDS_ATTENTION` (déjà mis à jour par le premier) — seul le
 * premier rend `true`. Le `WHERE prev.status <> 'SUSPENDED'` empêche
 * quiconque de rétrograder un serveur suspendu.
 */
export async function markGuildNeedsAttention(db: Db, guildId: string, reason: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ previousStatus: string }[]>`
    WITH prev AS (
      SELECT status FROM "Guild" WHERE id = ${guildId} FOR UPDATE
    )
    UPDATE "Guild" g
    SET status = 'NEEDS_ATTENTION', "statusReason" = ${reason}
    FROM prev
    WHERE g.id = ${guildId} AND prev.status <> 'SUSPENDED'
    RETURNING prev.status AS "previousStatus"
  `
  return rows[0]?.previousStatus === 'ACTIVE'
}

export async function suspendGuild(db: Db, discordGuildId: string): Promise<void> {
  await db.guild.updateMany({
    where: { discordGuildId },
    data: { status: 'SUSPENDED', statusReason: 'bot retiré du serveur' },
  })
  await db.eventMessage.updateMany({ where: { guildId: discordGuildId }, data: { disabled: true } })
}
