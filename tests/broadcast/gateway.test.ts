import { describe, it, expect } from 'vitest'
import { classifyDiscordError } from '../../src/broadcast/gateway.js'
import { discordError } from '../helpers/fake-gateway.js'

describe('classifyDiscordError', () => {
  it('traite les permissions et salons manquants comme une cible inutilisable', () => {
    for (const code of [50001, 50013, 10003]) {
      expect(classifyDiscordError(discordError(code))).toBe('TARGET_UNUSABLE')
    }
  })

  it('traite un message inconnu comme un message disparu', () => {
    expect(classifyDiscordError(discordError(10008))).toBe('MESSAGE_GONE')
  })

  it('traite tout le reste comme transitoire', () => {
    expect(classifyDiscordError(discordError(500))).toBe('TRANSIENT')
    expect(classifyDiscordError(new Error('socket hang up'))).toBe('TRANSIENT')
    expect(classifyDiscordError(undefined)).toBe('TRANSIENT')
  })
})
