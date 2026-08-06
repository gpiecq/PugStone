import { describe, it, expect } from 'vitest'
import { GatewayIntentBits } from 'discord.js'
import { createClient } from '../../src/bot/client.js'

describe('createClient', () => {
  it("ne demande que l'intent Guilds : le bot ne lit jamais le contenu des messages", () => {
    const client = createClient()

    expect(client.options.intents.bitfield).toBe(GatewayIntentBits.Guilds)
    expect(client.options.intents.toArray()).toEqual(['Guilds'])
  })
})
