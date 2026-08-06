import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCustomId, registerHandler, dispatchInteraction, resetHandlers } from '../../src/bot/router.js'
import { buildCustomId } from '../../src/broadcast/render.js'

function fakeInteraction(customId: string) {
  return {
    customId,
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(resetHandlers)

describe('parseCustomId', () => {
  it('analyse un identifiant bien formé', () => {
    expect(parseCustomId(buildCustomId('app', 'open', 'e1'))).toEqual({ domain: 'app', action: 'open', id: 'e1' })
  })

  it('rejette un préfixe absent, une version inconnue ou un format incomplet', () => {
    expect(parseCustomId('autre:1:app:open:e1')).toBeNull()
    expect(parseCustomId('pug:2:app:open:e1')).toBeNull()
    expect(parseCustomId('pug:1:app:open')).toBeNull()
  })

  it('produit un identifiant qui tient dans la limite Discord', () => {
    expect(buildCustomId('dash', 'accept', 'c'.repeat(25)).length).toBeLessThanOrEqual(100)
  })
})

describe('dispatchInteraction', () => {
  it('appelle le handler enregistré avec l\'identifiant extrait', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    registerHandler('app', 'open', handler)
    await dispatchInteraction(fakeInteraction(buildCustomId('app', 'open', 'e1')) as never, {} as never)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })

  it('répond une erreur générique plutôt que de laisser l\'interaction sans réponse', async () => {
    registerHandler('app', 'open', async () => { throw new Error('boom') })
    const interaction = fakeInteraction(buildCustomId('app', 'open', 'e1'))
    await dispatchInteraction(interaction as never, {} as never)
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
  })

  it('transforme une erreur métier en message utilisateur explicite', async () => {
    const { EventClosed } = await import('../../src/domain/errors.js')
    registerHandler('app', 'open', async () => { throw new EventClosed() })
    const interaction = fakeInteraction(buildCustomId('app', 'open', 'e1'))
    await dispatchInteraction(interaction as never, {} as never)
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer accepting') }),
    )
  })

  it('ignore silencieusement un identifiant inconnu', async () => {
    const interaction = fakeInteraction('bouton-d-un-autre-bot')
    await expect(dispatchInteraction(interaction as never, {} as never)).resolves.toBeUndefined()
    expect(interaction.reply).not.toHaveBeenCalled()
  })
})
