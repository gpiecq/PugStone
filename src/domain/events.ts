// Service d'annonces : brouillon, construction du roster, publication vers le
// réseau, annulation. Pièce centrale du domaine — les Tâches 8 (rendu), 9
// (worker d'émission), 10 (candidatures) et 14 (/recruit) s'appuient sur les
// signatures exposées ici, en particulier `EventView`, `loadEventView` et
// `bumpVersions`.

import type { Application, Difficulty, Event, Slot } from '@prisma/client'
import type { Db } from '../db/client.js'
import { findSpec } from '../config/wow.js'
import { listActiveGuilds } from './network.js'
import { EmptyRoster, NoActivePartners, NotAuthorized, DomainError } from './errors.js'

export interface EventView {
  event: Event
  slots: (Slot & { applications: Application[] })[]
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

export async function removeSlot(db: Db, slotId: string): Promise<void> {
  await db.slot.delete({ where: { id: slotId } })
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
    await tx.event.update({ where: { id: eventId }, data: { status: 'CANCELLED' } })
    await bumpVersions(tx, eventId, { public: true })
  })
}

export async function loadEventView(db: Db, eventId: string): Promise<EventView> {
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } })
  const slots = await db.slot.findMany({
    where: { eventId },
    orderBy: { position: 'asc' },
    include: { applications: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } } },
  })
  return { event, slots }
}
