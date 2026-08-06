import { describe, it, expect, vi } from 'vitest'
import { DiscordJsGateway } from '../../src/bot/gateway.js'
import { classifyDiscordError } from '../../src/broadcast/gateway.js'

// Double minimal d'un Client discord.js : seules les méthodes effectivement
// utilisées par DiscordJsGateway sont mockées, castées via `as never` comme
// le reste des doubles de test du projet (voir tests/bot/router.test.ts).
function fakeClient(overrides: { channel?: unknown; user?: unknown } = {}) {
  return {
    channels: { fetch: vi.fn().mockResolvedValue(overrides.channel ?? null) },
    users: { fetch: vi.fn().mockResolvedValue(overrides.user) },
  }
}

const payload = { embeds: [], components: [] }

describe('DiscordJsGateway', () => {
  it('envoie un message dans un salon textuel existant', async () => {
    const channel = { isTextBased: () => true, send: vi.fn().mockResolvedValue({ id: 'm1' }) }
    const gateway = new DiscordJsGateway(fakeClient({ channel }) as never)

    const result = await gateway.sendMessage('c1', payload)

    expect(result).toEqual({ messageId: 'm1' })
    expect(channel.send).toHaveBeenCalledWith(payload)
  })

  it('édite un message existant dans un salon textuel', async () => {
    const message = { edit: vi.fn().mockResolvedValue(undefined) }
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn().mockResolvedValue(message) } }
    const gateway = new DiscordJsGateway(fakeClient({ channel }) as never)

    await gateway.editMessage('c1', 'm1', payload)

    expect(message.edit).toHaveBeenCalledWith(payload)
  })

  it('lève une erreur de code 10003 quand le salon est introuvable', async () => {
    const gateway = new DiscordJsGateway(fakeClient({ channel: null }) as never)

    await expect(gateway.sendMessage('missing', payload)).rejects.toMatchObject({ code: 10003 })
  })

  it("lève une erreur de code 10003 quand le salon n'est pas textuel", async () => {
    const channel = { isTextBased: () => false }
    const gateway = new DiscordJsGateway(fakeClient({ channel }) as never)

    await expect(gateway.sendMessage('voice-channel', payload)).rejects.toMatchObject({ code: 10003 })
  })

  it('le code 10003 est classé comme cible inutilisable par classifyDiscordError (Tâche 4/9)', async () => {
    const gateway = new DiscordJsGateway(fakeClient({ channel: null }) as never)
    let caught: unknown
    try {
      await gateway.sendMessage('missing', payload)
    } catch (error) {
      caught = error
    }

    expect(classifyDiscordError(caught)).toBe('TARGET_UNUSABLE')
  })

  it("envoie un message privé en ouvrant le canal DM de l'utilisateur", async () => {
    const dm = { id: 'channel-dm', send: vi.fn().mockResolvedValue({ id: 'dm1' }) }
    const user = { createDM: vi.fn().mockResolvedValue(dm) }
    const gateway = new DiscordJsGateway(fakeClient({ user }) as never)

    const result = await gateway.sendDM('u1', payload)

    expect(result).toEqual({ channelId: 'channel-dm', messageId: 'dm1' })
  })

  it('crée un fil privé et y invite le candidat', async () => {
    const thread = { id: 'thread1', members: { add: vi.fn().mockResolvedValue(undefined) } }
    const channel = { isTextBased: () => true, threads: { create: vi.fn().mockResolvedValue(thread) } }
    const gateway = new DiscordJsGateway(fakeClient({ channel }) as never)

    const result = await gateway.createPrivateThread('c1', 'Candidature', 'u1')

    expect(result).toEqual({ channelId: 'thread1' })
    expect(thread.members.add).toHaveBeenCalledWith('u1')
  })
})
