import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { assertOwner, isRecruiter } from '../../src/bot/permissions.js'
import { NotAuthorized } from '../../src/domain/errors.js'
import { createInviteCode, redeemInviteCode, listActiveGuilds, markGuildNeedsAttention } from '../../src/domain/network.js'
import { buildNetworkStatus } from '../../src/commands/network.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

describe('autorisations', () => {
  it('n\'autorise que l\'owner du bot', () => {
    expect(() => assertOwner('u1', 'u1')).not.toThrow()
    expect(() => assertOwner('u2', 'u1')).toThrow(NotAuthorized)
  })

  it('reconnaît un recruteur par l\'un de ses rôles', () => {
    expect(isRecruiter(['a', 'b'], ['b'])).toBe(true)
    expect(isRecruiter(['a'], ['b', 'c'])).toBe(false)
    expect(isRecruiter(['a'], [])).toBe(false) // aucun rôle configuré = personne n'est recruteur
  })
})

describe('/network status', () => {
  it('résume les serveurs actifs, ceux à traiter et les émissions bloquées', async () => {
    const code1 = await createInviteCode(testDb, 'owner')
    const code2 = await createInviteCode(testDb, 'owner')
    const a = await redeemInviteCode(testDb, {
      code: code1, discordGuildId: 'gA', lfgChannelId: 'c', recruiterRoleIds: ['r'], timezone: 'Europe/Paris',
    })
    await redeemInviteCode(testDb, {
      code: code2, discordGuildId: 'gB', lfgChannelId: 'c', recruiterRoleIds: ['r'], timezone: 'Europe/Paris',
    })
    await markGuildNeedsAttention(testDb, a.id, 'missing permissions')

    const status = await buildNetworkStatus(testDb)
    expect(status).toContain('Active partners: 1')
    expect(status).toContain('gA')
    expect(status).toContain('missing permissions')
    expect(await listActiveGuilds(testDb)).toHaveLength(1)
  })
})
