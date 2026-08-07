// Service d'annonces : brouillon, construction du roster, publication vers le
// réseau, annulation. Pièce centrale du domaine — les Tâches 8 (rendu), 9
// (worker d'émission), 10 (candidatures) et 14 (/recruit) s'appuient sur les
// signatures exposées ici, en particulier `EventView`, `loadEventView` et
// `bumpVersions`.

import type { Application, Difficulty, Event, Slot } from '@prisma/client'
import type { Db } from '../db/client.js'
import { findSpec } from '../config/wow.js'
import { listActiveGuilds } from './network.js'
import { EmptyRoster, EventClosed, NoActivePartners, NotAuthorized, RaidTimeInvalid, SlotNotFound, DomainError } from './errors.js'

export interface EventView {
  event: Event
  slots: (Slot & { applications: Application[] })[]
  // Nom du serveur émetteur (Tâche 18), pas la relation `originGuild`
  // complète : c'est la seule information dont `renderPublicMessage` a
  // besoin, et exposer moins évite un couplage inutile côté rendu. Peut être
  // vide pour un serveur inscrit avant l'ajout de `Guild.name`.
  originGuildName: string
}

export interface CreateDraftParams {
  originGuildId: string
  authorId: string
  raidName: string
  difficulty: Difficulty
  scheduledAt: Date
}

export function createDraft(db: Db, params: CreateDraftParams): Promise<Event> {
  return db.event.create({ data: { ...params, status: 'DRAFT' } })
}

export async function addSlot(db: Db, eventId: string, spec: { className: string; specName: string }): Promise<Slot> {
  const resolved = findSpec(spec.className, spec.specName)
  if (!resolved) throw new DomainError('spé inconnue', 'Unknown class or specialization.')
  const position = await db.slot.count({ where: { eventId } })
  return db.slot.create({
    data: {
      eventId, className: spec.className.toUpperCase(), specName: spec.specName.toUpperCase(),
      role: resolved.role, position,
    },
  })
}

/**
 * Contraint la suppression à l'annonce passée : sans ce filtre, `slotId` seul
 * suffisait à supprimer la place d'une AUTRE annonce que celle validée par
 * `requireAuthor` côté handler (revue finale, constat I4). `deleteMany` rend
 * ce contrôle atomique — pas de fenêtre entre une lecture qui vérifierait
 * `eventId` et une suppression séparée.
 */
export async function removeSlot(db: Db, eventId: string, slotId: string): Promise<void> {
  const { count } = await db.slot.deleteMany({ where: { id: slotId, eventId } })
  if (count === 0) throw new SlotNotFound()
}

export async function setContact(db: Db, eventId: string, contact: string): Promise<void> {
  await db.event.update({ where: { id: eventId }, data: { authorContact: contact } })
}

/**
 * Incrémente les compteurs de version. Toujours appelé DANS la transaction qui
 * porte le changement métier : c'est ce qui garantit qu'un message publié ne
 * peut pas refléter un état que la base n'a pas validé.
 */
export async function bumpVersions(tx: Db, eventId: string, options: { public: boolean }): Promise<void> {
  await tx.event.update({
    where: { id: eventId },
    data: {
      dashboardVersion: { increment: 1 },
      ...(options.public ? { publicVersion: { increment: 1 } } : {}),
    },
  })
}

export async function publishEvent(db: Db, eventId: string): Promise<{ targets: number }> {
  return db.$transaction(async (tx) => {
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, include: { originGuild: true } })
    // Un double-clic sur [Publish LFM] republiait sinon une annonce déjà
    // PUBLISHED : le createMany suivant heurtait la contrainte unique
    // d'EventMessage et remontait une P2002 brute (revue finale, constat I9).
    if (event.status !== 'DRAFT') throw new EventClosed()
    // Un brouillon créé pour une heure désormais passée (temps écoulé entre
    // création et publication) partirait en fan-out sur tout le réseau pour
    // expirer dans la minute — N publications et N éditions inutiles (revue
    // finale, constat I8).
    if (event.scheduledAt.getTime() <= Date.now()) {
      throw new RaidTimeInvalid("This listing's raid time has already passed. Cancel this draft and create a new one.")
    }
    const slots = await tx.slot.count({ where: { eventId } })
    if (slots === 0) throw new EmptyRoster()

    const guilds = await listActiveGuilds(tx)
    if (guilds.length === 0) throw new NoActivePartners()

    await tx.eventMessage.createMany({
      data: guilds.map((guild) => ({
        eventId, guildId: guild.discordGuildId,
        channelId: guild.lfgChannelId!, kind: 'PUBLIC' as const,
      })),
    })
    // Le dashboard n'a pas encore de salon : il sera résolu par le worker,
    // qui tente le DM puis se rabat sur un thread privé.
    await tx.eventMessage.create({
      data: {
        eventId, guildId: event.originGuild.discordGuildId,
        channelId: '', kind: 'DASHBOARD',
      },
    })
    await tx.event.update({
      where: { id: eventId },
      data: { status: 'PUBLISHED', publicVersion: { increment: 1 }, dashboardVersion: { increment: 1 } },
    })
    return { targets: guilds.length }
  })
}

export async function cancelEvent(db: Db, eventId: string, actorId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } })
    if (event.authorId !== actorId) throw new NotAuthorized('cancelling this listing')
    await tx.event.update({ where: { id: eventId }, data: { status: 'CANCELLED', closedAt: new Date() } })
    await bumpVersions(tx, eventId, { public: true })
  })
}

export async function loadEventView(db: Db, eventId: string): Promise<EventView> {
  // `originGuild` n'est chargée que pour son nom (`select`), au même endroit
  // que la requête sur `Event` : pas de second aller-retour base pour cette
  // seule information, comme le fait déjà `publishEvent` pour la relation
  // complète.
  const { originGuild, ...event } = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    include: { originGuild: { select: { name: true } } },
  })
  const slots = await db.slot.findMany({
    where: { eventId },
    orderBy: { position: 'asc' },
    include: { applications: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } } },
  })
  return { event, slots, originGuildName: originGuild.name }
}
