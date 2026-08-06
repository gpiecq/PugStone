import { describe, it, expect } from 'vitest'
import { loadEnv } from '../../src/config/env.js'

const valid = {
  DISCORD_TOKEN: 'token',
  DISCORD_APP_ID: '123',
  OWNER_DISCORD_ID: '456',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
}

describe('loadEnv', () => {
  it('accepte une configuration complète et applique LOG_LEVEL=info par défaut', () => {
    expect(loadEnv(valid).LOG_LEVEL).toBe('info')
  })

  it('échoue en nommant la variable manquante', () => {
    const { DISCORD_TOKEN, ...incomplete } = valid
    expect(() => loadEnv(incomplete)).toThrow(/DISCORD_TOKEN/)
  })

  it('refuse un LOG_LEVEL inconnu', () => {
    expect(() => loadEnv({ ...valid, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/)
  })
})
