import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { expireDueEvents } from '../../src/scheduler/expiration.js'
import { purgeOldEvents } from '../../src/scheduler/retention.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

async function published(scheduledAt: Date) {
  const guild = await makeGuild(testDb)
  const draft = await makeDraft(testDb, guild.id)
  await testDb.event.update({ where: { id: draft.id }, data: { scheduledAt } })
  await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
  await publishEvent(testDb, draft.id)
  return draft
}

describe('expiration', () => {
  it('expire les annonces dont l\'heure est passée et incrémente la version publique', async () => {
    const event = await published(new Date('2026-08-06T18:00:00Z'))
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })

    const count = await expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z'))
    expect(count).toBe(1)
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.status).toBe('EXPIRED')
    expect(after.publicVersion).toBe(before.publicVersion + 1)
  })

  it('laisse intactes les annonces à venir', async () => {
    await published(new Date('2026-08-09T18:00:00Z'))
    expect(await expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z'))).toBe(0)
  })

  it('ne touche ni aux annonces closes ni aux brouillons', async () => {
    const guild = await makeGuild(testDb)
    await makeDraft(testDb, guild.id) // reste en DRAFT
    const done = await published(new Date('2026-08-06T18:00:00Z'))
    await testDb.event.update({ where: { id: done.id }, data: { status: 'COMPLETED' } })

    expect(await expireDueEvents(testDb, new Date('2026-08-06T19:00:00Z'))).toBe(0)
  })

  it('est idempotent : un second passage n\'incrémente plus la version', async () => {
    const event = await published(new Date('2026-08-06T18:00:00Z'))
    await expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z'))
    const first = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    await expireDueEvents(testDb, new Date('2026-08-06T18:02:00Z'))
    const second = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(second.publicVersion).toBe(first.publicVersion)
  })

  it('renseigne closedAt avec le `now` injecté, pas l\'horloge système', async () => {
    const event = await published(new Date('2026-08-06T18:00:00Z'))
    const now = new Date('2026-08-06T18:01:00Z')
    await expireDueEvents(testDb, now)
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.closedAt).toEqual(now)
  })

  it('reste idempotent sous deux passages concurrents sur la même annonce', async () => {
    const event = await published(new Date('2026-08-06T18:00:00Z'))
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })

    // Réchauffe le pool de connexions : sans ça, les deux appels de
    // `expireDueEvents` ci-dessous se retrouvent sérialisés sur une unique
    // connexion déjà établie (le second attend qu'une deuxième connexion
    // s'ouvre, largement plus lent qu'un aller-retour SQL local), et la
    // fenêtre de course entre lecture et écriture ne s'ouvre jamais.
    await Promise.all([testDb.$queryRaw`SELECT 1`, testDb.$queryRaw`SELECT 1`])

    const [a, b] = await Promise.all([
      expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z')),
      expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z')),
    ])

    expect(a + b).toBe(1)
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.publicVersion).toBe(before.publicVersion + 1)
    expect(after.dashboardVersion).toBe(before.dashboardVersion + 1)
  })
})

describe('rétention', () => {
  it('supprime les annonces terminées au-delà de la période de conservation, candidatures comprises', async () => {
    const event = await published(new Date('2026-06-01T18:00:00Z'))
    await testDb.event.update({ where: { id: event.id }, data: { status: 'EXPIRED' } })
    const slot = await testDb.slot.findFirstOrThrow({ where: { eventId: event.id } })
    await testDb.application.create({
      data: {
        slotId: slot.id, applicantId: 'app-purged', applicantTag: 'Purged#1',
        ignRealm: 'Purged-Hyjal', itemLevel: 620, logsUrl: 'https://warcraftlogs.com/purged',
      },
    })

    // candidature sur une annonce distincte, non purgeable : la cascade ne
    // doit pas déborder au-delà de l'annonce ciblée.
    const survivor = await published(new Date('2026-08-09T18:00:00Z'))
    const survivorSlot = await testDb.slot.findFirstOrThrow({ where: { eventId: survivor.id } })
    await testDb.application.create({
      data: {
        slotId: survivorSlot.id, applicantId: 'app-survivor', applicantTag: 'Survivor#1',
        ignRealm: 'Survivor-Hyjal', itemLevel: 620, logsUrl: 'https://warcraftlogs.com/survivor',
      },
    })

    const removed = await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)
    expect(removed).toBe(1)
    expect(await testDb.event.count()).toBe(1)
    expect(await testDb.slot.count()).toBe(1)
    expect(await testDb.eventMessage.count({ where: { eventId: event.id } })).toBe(0)
    expect(await testDb.application.count()).toBe(1)
    const remaining = await testDb.application.findFirstOrThrow()
    expect(remaining.applicantId).toBe('app-survivor')
  })

  it('conserve les annonces encore actives, même anciennes', async () => {
    await published(new Date('2026-06-01T18:00:00Z'))
    expect(await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)).toBe(0)
  })

  it('purge selon la date de clôture réelle, pas selon la date de raid prévue', async () => {
    // Raid prévu dans un futur lointain, mais annulé il y a plus de 30 jours :
    // c'est le cas qui motive la Tâche 11b. Avec l'ancienne règle (ancrée sur
    // scheduledAt), cette annonce ne serait purgeable qu'en 2027.
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await testDb.event.update({
      where: { id: draft.id },
      data: {
        scheduledAt: new Date('2027-06-01T18:00:00Z'),
        status: 'CANCELLED',
        closedAt: new Date('2026-07-01T18:00:00Z'),
      },
    })

    const removed = await purgeOldEvents(testDb, new Date('2026-08-01T18:00:00Z'), 30)
    expect(removed).toBe(1)
  })

  it('se replie sur scheduledAt quand closedAt est nul (annonces closes avant la migration)', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await testDb.event.update({
      where: { id: draft.id },
      data: { scheduledAt: new Date('2026-06-01T18:00:00Z'), status: 'EXPIRED', closedAt: null },
    })

    const removed = await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)
    expect(removed).toBe(1)
  })

  it('ne purge pas une annonce close récemment, même avec une date de raid ancienne', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await testDb.event.update({
      where: { id: draft.id },
      data: {
        scheduledAt: new Date('2026-06-01T18:00:00Z'),
        status: 'CANCELLED',
        closedAt: new Date('2026-08-01T18:00:00Z'),
      },
    })

    const removed = await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)
    expect(removed).toBe(0)
  })
})
