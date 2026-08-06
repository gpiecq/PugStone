// Candidatures et acceptation : la garantie centrale du produit est ici — une
// place ne peut jamais être attribuée à deux candidats, même si deux Raid
// Leaders (ou le même, en double-clic) acceptent au même instant. Le verrou
// pessimiste `FOR UPDATE` porte sur la ligne `Slot` et vit dans la même
// transaction interactive que les écritures qu'il protège (leçon de la
// Tâche 9 : hors transaction, `FOR UPDATE` relâche son verrou dès le retour
// de la requête).

import type { Application, Slot } from '@prisma/client'
import type { Db } from '../db/client.js'
import { bumpVersions } from './events.js'
import { EventClosed, NotAuthorized, SlotAlreadyFilled, SlotNotFound } from './errors.js'

const MIN_ILVL = 100
const MAX_ILVL = 1500
const ALLOWED_LOGS_HOSTS = ['warcraftlogs.com', 'www.warcraftlogs.com']

export interface ValidatedApplication {
  ignRealm: string
  itemLevel: number
  logsUrl: string
  comment: string | null
}

export type ValidationResult =
  | { ok: true; value: ValidatedApplication }
  | { ok: false; errors: string[] }

/**
 * Discord ne conserve pas la saisie d'un modal refusé : le message d'erreur doit
 * lister tous les problèmes d'un coup, sinon le joueur ressaisit trois fois.
 */
export function validateApplicationInput(raw: {
  ignRealm: string
  itemLevel: string
  logsUrl: string
  comment?: string | null
}): ValidationResult {
  const errors: string[] = []

  const ignRealm = raw.ignRealm.trim()
  if (ignRealm.length < 3 || ignRealm.length > 64) {
    errors.push('In-game name & realm must be between 3 and 64 characters (e.g. `Pug-Hyjal`).')
  }

  const itemLevel = Number(raw.itemLevel.trim())
  if (!Number.isInteger(itemLevel) || itemLevel < MIN_ILVL || itemLevel > MAX_ILVL) {
    errors.push(`Item level must be a whole number between ${MIN_ILVL} and ${MAX_ILVL}.`)
  }

  let logsUrl = ''
  try {
    const parsed = new URL(raw.logsUrl.trim())
    if (!ALLOWED_LOGS_HOSTS.includes(parsed.hostname)) throw new Error('host')
    logsUrl = parsed.toString()
  } catch {
    errors.push('WarcraftLogs link must be a full URL on warcraftlogs.com.')
  }

  const comment = raw.comment?.trim() ? raw.comment.trim().slice(0, 300) : null
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { ignRealm, itemLevel, logsUrl, comment } }
}

export interface SubmitParams extends ValidatedApplication {
  slotId: string
  applicantId: string
  applicantTag: string
}

export async function submitApplication(db: Db, params: SubmitParams): Promise<Application> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; eventId: string; status: string }[]>`
      SELECT id, "eventId", status FROM "Slot" WHERE id = ${params.slotId} FOR UPDATE
    `
    const slot = locked[0]
    if (!slot) throw new SlotNotFound()
    if (slot.status === 'FILLED') throw new SlotAlreadyFilled()

    const event = await tx.event.findUniqueOrThrow({ where: { id: slot.eventId } })
    if (event.status !== 'PUBLISHED') throw new EventClosed()

    const application = await tx.application.upsert({
      where: { slotId_applicantId: { slotId: params.slotId, applicantId: params.applicantId } },
      create: {
        slotId: params.slotId, applicantId: params.applicantId, applicantTag: params.applicantTag,
        ignRealm: params.ignRealm, itemLevel: params.itemLevel, logsUrl: params.logsUrl, comment: params.comment,
      },
      update: {
        applicantTag: params.applicantTag, ignRealm: params.ignRealm, itemLevel: params.itemLevel,
        logsUrl: params.logsUrl, comment: params.comment, status: 'PENDING',
      },
    })
    await bumpVersions(tx, slot.eventId, { public: false })
    return application
  })
}

export interface AcceptResult {
  applicantId: string
  contact: string
  raidName: string
  eventCompleted: boolean
}

export async function acceptApplication(db: Db, params: { applicationId: string; actorId: string }): Promise<AcceptResult> {
  return db.$transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({
      where: { id: params.applicationId },
      include: { slot: { include: { event: true } } },
    })
    const { slot } = application
    if (slot.event.authorId !== params.actorId) throw new NotAuthorized('accepting applications for this listing')

    // Verrou d'annonce : posé AVANT le verrou de place, dans cet ordre constant
    // (Event puis Slot, jamais l'inverse — `submitApplication` ne verrouille que
    // la place et ne peut donc jamais inverser cet ordre). Il sérialise deux
    // acceptations concurrentes sur la même annonce, y compris sur deux places
    // différentes, ce qui protège le comptage `stillOpen` ci-dessous. Il se
    // synchronise aussi avec `cancelEvent` : celui-ci ne pose pas de verrou
    // explicite, mais son `UPDATE` sur la ligne `Event` prend le même verrou de
    // ligne Postgres, donc il attend ou fait attendre `acceptApplication` selon
    // qui arrive en premier. Le statut de l'annonce est ensuite contrôlé à
    // partir de CETTE lecture verrouillée, jamais de la lecture initiale
    // ci-dessus (qui peut être périmée) : c'est ce qui ferme la fenêtre TOCTOU
    // par laquelle une acceptation pouvait aboutir après une annulation déjà
    // committée, et faire régresser le statut de CANCELLED à COMPLETED.
    const lockedEvent = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "Event" WHERE id = ${slot.eventId} FOR UPDATE
    `
    if (lockedEvent[0]?.status !== 'PUBLISHED') throw new EventClosed()

    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "Slot" WHERE id = ${slot.id} FOR UPDATE
    `
    if (locked[0]?.status === 'FILLED') throw new SlotAlreadyFilled()

    await tx.application.update({ where: { id: application.id }, data: { status: 'ACCEPTED' } })
    await tx.application.updateMany({
      where: { slotId: slot.id, id: { not: application.id }, status: 'PENDING' },
      data: { status: 'DISCARDED' },
    })
    await tx.slot.update({
      where: { id: slot.id },
      data: { status: 'FILLED', acceptedApplicationId: application.id },
    })

    const stillOpen = await tx.slot.count({ where: { eventId: slot.eventId, status: 'OPEN' } })
    const eventCompleted = stillOpen === 0
    if (eventCompleted) {
      await tx.event.update({ where: { id: slot.eventId }, data: { status: 'COMPLETED' } })
    }
    await bumpVersions(tx, slot.eventId, { public: true })

    return {
      applicantId: application.applicantId,
      contact: slot.event.authorContact,
      raidName: slot.event.raidName,
      eventCompleted,
    }
  })
}

export function openSlots(db: Db, eventId: string): Promise<Slot[]> {
  return db.slot.findMany({ where: { eventId, status: 'OPEN' }, orderBy: { position: 'asc' } })
}
