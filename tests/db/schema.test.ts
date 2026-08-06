import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

async function seedSlot() {
  const guild = await testDb.guild.create({
    data: { discordGuildId: 'g1', timezone: 'Europe/Paris', recruiterRoleIds: [] },
  })
  const event = await testDb.event.create({
    data: {
      originGuildId: guild.id, authorId: 'u1', raidName: 'Nerub-ar',
      difficulty: 'HEROIC', scheduledAt: new Date('2026-09-01T19:00:00Z'),
    },
  })
  return testDb.slot.create({
    data: { eventId: event.id, className: 'MAGE', specName: 'ARCANE', role: 'DPS', position: 0 },
  })
}

describe('contraintes du schéma', () => {
  it('interdit deux candidatures du même joueur sur la même place', async () => {
    const slot = await seedSlot()
    const base = {
      slotId: slot.id, applicantId: 'p1', applicantTag: 'p1#0',
      ignRealm: 'Pug-Hyjal', itemLevel: 620, logsUrl: 'https://warcraftlogs.com/x',
    }
    await testDb.application.create({ data: base })
    await expect(testDb.application.create({ data: base })).rejects.toThrow()
  })

  it('interdit deux messages du même type pour la même annonce et le même serveur', async () => {
    const slot = await seedSlot()
    const row = { eventId: slot.eventId, guildId: 'g1', channelId: 'c1', kind: 'PUBLIC' as const }
    await testDb.eventMessage.create({ data: row })
    await expect(testDb.eventMessage.create({ data: row })).rejects.toThrow()
  })

  it('supprime en cascade les places et candidatures avec leur annonce', async () => {
    const slot = await seedSlot()
    await testDb.event.delete({ where: { id: slot.eventId } })
    expect(await testDb.slot.count()).toBe(0)
  })
})
