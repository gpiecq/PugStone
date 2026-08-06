import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft, makeSlot } from '../helpers/factories.js'
import { addSlot, loadEventView } from '../../src/domain/events.js'
import { renderRosterBuilder, registerRosterHandlers } from '../../src/interactions/roster.js'
import { dispatchInteraction, resetHandlers, type BotDeps } from '../../src/bot/router.js'
import { buildCustomId } from '../../src/broadcast/render.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>' }

// Double minimal d'interaction : uniquement ce dont dispatchInteraction et les
// handlers du roster ont besoin (customId, user.id, values pour un select,
// update pour la ré-édition, reply/followUp pour le message d'erreur
// éphémère de replyEphemeral) — pas de simulation complète de discord.js.
function fakeInteraction(customId: string, userId: string, values?: string[]) {
  return {
    customId,
    user: { id: userId },
    values,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  }
}

function deps(): BotDeps {
  return { db: testDb, gateway: {} as never, emojis, ownerId: 'owner' }
}

describe('constructeur de roster', () => {
  it('propose les 13 classes et aucun select de spé tant qu\'aucune classe n\'est choisie', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), null, emojis)
    const rows = payload.components as { components: { custom_id: string; options?: unknown[] }[] }[]
    const classSelect = rows[0]!.components[0]!
    expect(classSelect.custom_id).toBe(`pug:1:roster:class:${draft.id}`)
    expect(classSelect.options).toHaveLength(13)
    expect(rows.some((r) => r.components[0]!.custom_id.includes(':spec:'))).toBe(false)
  })

  it('affiche les spés de la classe choisie', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), 'MAGE', emojis)
    const rows = payload.components as { components: { custom_id: string; options?: { value: string }[] }[] }[]
    const specSelect = rows.find((r) => r.components[0]!.custom_id.includes(':spec:'))!.components[0]!
    expect(specSelect.options!.map((o) => o.value)).toEqual(['ARCANE', 'FIRE', 'FROST'])
  })

  it('liste les places ajoutées et active la publication', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), null, emojis)
    expect((payload.embeds[0] as { description: string }).description).toContain('Arcane')
    const publish = (payload.components as { components: { custom_id: string; disabled?: boolean }[] }[])
      .flatMap((r) => r.components).find((c) => c.custom_id.includes(':publish:'))!
    expect(publish.disabled).toBe(false)
  })

  it('désactive la publication tant que le roster est vide', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), null, emojis)
    const publish = (payload.components as { components: { custom_id: string; disabled?: boolean }[] }[])
      .flatMap((r) => r.components).find((c) => c.custom_id.includes(':publish:'))!
    expect(publish.disabled).toBe(true)
  })
})

describe('contrôle de propriété du brouillon', () => {
  beforeEach(() => {
    resetHandlers()
    registerRosterHandlers()
  })

  it('roster:spec refuse un non-auteur : NotAuthorized, aucune place ajoutée', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const interaction = fakeInteraction(buildCustomId('roster', 'spec', `${draft.id}|MAGE`), 'intruder', ['ARCANE'])

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.update).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not allowed') }))
    expect(await testDb.slot.findMany({ where: { eventId: draft.id } })).toHaveLength(0)
  })

  it('roster:spec autorise l\'auteur légitime : la place est bien ajoutée', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const interaction = fakeInteraction(buildCustomId('roster', 'spec', `${draft.id}|MAGE`), 'rl-1', ['ARCANE'])

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.update).toHaveBeenCalled()
    expect(await testDb.slot.findMany({ where: { eventId: draft.id } })).toHaveLength(1)
  })

  it('roster:remove refuse un non-auteur : NotAuthorized, la place reste en base', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const slot = await makeSlot(testDb, draft.id)
    const interaction = fakeInteraction(buildCustomId('roster', 'remove', draft.id), 'intruder', [slot.id])

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.update).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not allowed') }))
    expect(await testDb.slot.findUnique({ where: { id: slot.id } })).not.toBeNull()
  })

  it('roster:publish refuse un non-auteur : NotAuthorized, rien n\'est publié', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    await makeSlot(testDb, draft.id)
    const interaction = fakeInteraction(buildCustomId('roster', 'publish', draft.id), 'intruder')

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.update).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not allowed') }))
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('DRAFT')
    expect(await testDb.eventMessage.findMany({ where: { eventId: draft.id } })).toHaveLength(0)
  })

  it('roster:publish autorise l\'auteur légitime : l\'annonce est bien publiée', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    await makeSlot(testDb, draft.id)
    const interaction = fakeInteraction(buildCustomId('roster', 'publish', draft.id), 'rl-1')

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.update).toHaveBeenCalled()
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('PUBLISHED')
  })
})
