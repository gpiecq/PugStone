import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import {
  createInviteCode, revokeInviteCode, redeemInviteCode,
  updateGuildConfig, listActiveGuilds, markGuildNeedsAttention, suspendGuild,
} from '../../src/domain/network.js'
import { GuildNotOnboarded, InviteCodeUnusable } from '../../src/domain/errors.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const config = (code: string, guild = 'g1') => ({
  code, discordGuildId: guild, lfgChannelId: 'c1',
  recruiterRoleIds: ['r1'], timezone: 'Europe/Paris',
})

describe('admission au réseau', () => {
  it('consomme un code et crée le serveur partenaire', async () => {
    const code = await createInviteCode(testDb, 'owner')
    const guild = await redeemInviteCode(testDb, config(code))
    expect(guild.status).toBe('ACTIVE')
    expect(guild.lfgChannelId).toBe('c1')
    const used = await testDb.inviteCode.findUniqueOrThrow({ where: { code } })
    expect(used.usedByGuild).toBe(guild.id)
    expect(used.usedAt).not.toBeNull()
  })

  it('refuse un code déjà consommé', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await redeemInviteCode(testDb, config(code, 'g1'))
    await expect(redeemInviteCode(testDb, config(code, 'g2'))).rejects.toBeInstanceOf(InviteCodeUnusable)
  })

  it('refuse un code révoqué ou inexistant', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await revokeInviteCode(testDb, code)
    await expect(redeemInviteCode(testDb, config(code))).rejects.toBeInstanceOf(InviteCodeUnusable)
    await expect(redeemInviteCode(testDb, config('inconnu'))).rejects.toBeInstanceOf(InviteCodeUnusable)
  })

  it('ne consomme le code qu\'une seule fois même sous deux appels simultanés', async () => {
    const code = await createInviteCode(testDb, 'owner')
    const results = await Promise.allSettled([
      redeemInviteCode(testDb, config(code, 'gA')),
      redeemInviteCode(testDb, config(code, 'gB')),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await testDb.guild.count()).toBe(1)
  })

  it('enregistre le nom du serveur transmis à l\'inscription', async () => {
    const code = await createInviteCode(testDb, 'owner')
    const guild = await redeemInviteCode(testDb, { ...config(code), name: 'Horde Raiders EU' })
    expect(guild.name).toBe('Horde Raiders EU')
  })

  it('met à jour le nom du serveur lors d\'une reconfiguration', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await redeemInviteCode(testDb, config(code))
    const updated = await updateGuildConfig(testDb, { discordGuildId: 'g1', name: 'Alliance Raiders EU' })
    expect(updated.name).toBe('Alliance Raiders EU')
  })

  it('permet de reconfigurer un serveur sans nouveau code', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await redeemInviteCode(testDb, config(code))
    const updated = await updateGuildConfig(testDb, {
      discordGuildId: 'g1', lfgChannelId: 'c2', recruiterRoleIds: ['r2', 'r3'],
    })
    expect(updated.lfgChannelId).toBe('c2')
    expect(updated.recruiterRoleIds).toEqual(['r2', 'r3'])
    expect(updated.timezone).toBe('Europe/Paris')
  })

  it('refuse de reconfigurer un serveur qui n\'a jamais rejoint le réseau', async () => {
    await expect(
      updateGuildConfig(testDb, { discordGuildId: 'jamais-inscrit', lfgChannelId: 'c9' }),
    ).rejects.toBeInstanceOf(GuildNotOnboarded)
  })

  it('reconfigure toujours normalement un serveur déjà inscrit (non-régression)', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await redeemInviteCode(testDb, config(code, 'g9'))
    const updated = await updateGuildConfig(testDb, {
      discordGuildId: 'g9', lfgChannelId: 'c9', timezone: 'America/New_York',
    })
    expect(updated.lfgChannelId).toBe('c9')
    expect(updated.timezone).toBe('America/New_York')
    expect(updated.status).toBe('ACTIVE')
  })
})

describe('cibles de diffusion', () => {
  it('ne retient que les serveurs actifs avec un salon configuré', async () => {
    const code1 = await createInviteCode(testDb, 'owner')
    const code2 = await createInviteCode(testDb, 'owner')
    const code3 = await createInviteCode(testDb, 'owner')
    const a = await redeemInviteCode(testDb, config(code1, 'gA'))
    await redeemInviteCode(testDb, config(code2, 'gB'))
    await redeemInviteCode(testDb, config(code3, 'gC'))
    await markGuildNeedsAttention(testDb, a.id, 'salon supprimé')
    await suspendGuild(testDb, 'gB')

    const active = await listActiveGuilds(testDb)
    expect(active.map((g) => g.discordGuildId)).toEqual(['gC'])
  })
})

describe('suspension d\'un serveur', () => {
  it('suspend le serveur et coupe l\'émission de ses messages sans toucher aux autres', async () => {
    const codeX = await createInviteCode(testDb, 'owner')
    const codeY = await createInviteCode(testDb, 'owner')
    const guildX = await redeemInviteCode(testDb, config(codeX, 'gX'))
    await redeemInviteCode(testDb, config(codeY, 'gY'))

    const event = await testDb.event.create({
      data: {
        originGuildId: guildX.id,
        authorId: 'author',
        raidName: 'Nerub-ar Palace',
        difficulty: 'HEROIC',
        scheduledAt: new Date(),
      },
    })
    const messageX = await testDb.eventMessage.create({
      data: { eventId: event.id, guildId: 'gX', channelId: 'c1', kind: 'PUBLIC' },
    })
    const messageY = await testDb.eventMessage.create({
      data: { eventId: event.id, guildId: 'gY', channelId: 'c1', kind: 'PUBLIC' },
    })

    await suspendGuild(testDb, 'gX')

    const suspended = await testDb.guild.findUniqueOrThrow({ where: { discordGuildId: 'gX' } })
    expect(suspended.status).toBe('SUSPENDED')

    const updatedX = await testDb.eventMessage.findUniqueOrThrow({ where: { id: messageX.id } })
    expect(updatedX.disabled).toBe(true)

    const updatedY = await testDb.eventMessage.findUniqueOrThrow({ where: { id: messageY.id } })
    expect(updatedY.disabled).toBe(false)
  })
})
