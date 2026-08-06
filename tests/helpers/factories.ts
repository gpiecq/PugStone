// Fabriques de test partagées entre les Tâches 7, 9, 10 et 11 : elles posent
// les données minimales (guilde, brouillon, place) sans imposer de scénario
// métier, chaque test ne précise que ce qui compte pour lui via `overrides`.

import type { Db } from '../../src/db/client.js'

export async function makeGuild(db: Db, overrides: Partial<{ discordGuildId: string; lfgChannelId: string | null }> = {}) {
  return db.guild.create({
    data: {
      discordGuildId: overrides.discordGuildId ?? `g${Math.random().toString(36).slice(2, 8)}`,
      lfgChannelId: overrides.lfgChannelId === undefined ? 'chan' : overrides.lfgChannelId,
      recruiterRoleIds: ['role-rl'],
      timezone: 'Europe/Paris',
    },
  })
}

export async function makeDraft(db: Db, guildId: string, authorId = 'rl-1') {
  return db.event.create({
    data: {
      originGuildId: guildId, authorId, authorContact: 'RaidLead#1234',
      raidName: 'Nerub-ar Palace', difficulty: 'HEROIC',
      scheduledAt: new Date('2026-09-01T19:00:00Z'),
    },
  })
}

export async function makeSlot(db: Db, eventId: string, className = 'MAGE', specName = 'ARCANE', position = 0) {
  return db.slot.create({
    data: { eventId, className, specName, role: 'DPS', position },
  })
}
