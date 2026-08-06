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
})

describe('rétention', () => {
  it('supprime les annonces terminées au-delà de la période de conservation', async () => {
    const event = await published(new Date('2026-06-01T18:00:00Z'))
    await testDb.event.update({ where: { id: event.id }, data: { status: 'EXPIRED' } })

    const removed = await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)
    expect(removed).toBe(1)
    expect(await testDb.event.count()).toBe(0)
    expect(await testDb.slot.count()).toBe(0)
    expect(await testDb.eventMessage.count()).toBe(0)
  })

  it('conserve les annonces encore actives, même anciennes', async () => {
    await published(new Date('2026-06-01T18:00:00Z'))
    expect(await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)).toBe(0)
  })
})
