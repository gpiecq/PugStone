import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, loadEventView } from '../../src/domain/events.js'
import { renderRosterBuilder } from '../../src/interactions/roster.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>' }

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
