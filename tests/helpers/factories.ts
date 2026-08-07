// Fabriques de test partagées entre les Tâches 7, 9, 10 et 11 : elles posent
// les données minimales (guilde, brouillon, place) sans imposer de scénario
// métier, chaque test ne précise que ce qui compte pour lui via `overrides`.

import type { Db } from '../../src/db/client.js'

export async function makeGuild(db: Db, overrides: Partial<{ discordGuildId: string; lfgChannelId: string | null; name: string }> = {}) {
  return db.guild.create({
    data: {
      discordGuildId: overrides.discordGuildId ?? `g${Math.random().toString(36).slice(2, 8)}`,
      lfgChannelId: overrides.lfgChannelId === undefined ? 'chan' : overrides.lfgChannelId,
      recruiterRoleIds: ['role-rl'],
      timezone: 'Europe/Paris',
      // Non renseigné par défaut : les tests qui ne portent pas sur le nom du
      // serveur émetteur laissent Prisma appliquer le défaut `""` du schéma.
      ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    },
  })
}

export async function makeDraft(db: Db, guildId: string, authorId = 'rl-1') {
  return db.event.create({
    data: {
      originGuildId: guildId, authorId, authorContact: 'RaidLead#1234',
      raidName: 'Nerub-ar Palace', difficulty: 'HEROIC',
      // Relative à l'instant courant plutôt qu'absolue : `publishEvent` refuse
      // désormais de publier une annonce dont `scheduledAt` est déjà passé
      // (I8, revue finale). Une date codée en dur finirait, un jour, par se
      // retrouver dans le passé et faire échouer tous les appelants de cette
      // fabrique qui publient ensuite le brouillon.
      scheduledAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  })
}

export async function makeSlot(db: Db, eventId: string, className = 'MAGE', specName = 'ARCANE', position = 0) {
  return db.slot.create({
    data: { eventId, className, specName, role: 'DPS', position },
  })
}
