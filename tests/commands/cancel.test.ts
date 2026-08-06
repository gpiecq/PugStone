// /cancel : deuxième chemin vers `cancelEvent`, en plus du bouton dash:close
// (tests/interactions/dashboard.test.ts). On vérifie ici le contrôle de
// propriété, l'effet réel en base, et que l'autocomplétion ne propose que les
// annonces publiées de l'appelant — jamais celles d'un tiers ni un brouillon.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { cancelCommand } from '../../src/commands/cancel.js'
import type { BotDeps } from '../../src/bot/router.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

function deps(): BotDeps {
  return { db: testDb, gateway: {} as never, emojis: {}, ownerId: 'owner' }
}

async function publishedDraft(guildId: string, authorId: string, raidName = 'Nerub-ar Palace') {
  const draft = await testDb.event.create({
    data: {
      originGuildId: guildId, authorId, authorContact: 'RaidLead#1234',
      raidName, difficulty: 'HEROIC', scheduledAt: new Date('2026-09-01T19:00:00Z'),
    },
  })
  await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
  await publishEvent(testDb, draft.id)
  return draft
}

function fakeExecuteInteraction(userId: string, listingId: string) {
  return {
    user: { id: userId },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: { getString: (_name: string, _required: true) => listingId },
  }
}

describe('/cancel execute', () => {
  it("l'auteur annule sa propre annonce : statut CANCELLED, confirmation renvoyée", async () => {
    const guild = await makeGuild(testDb)
    const draft = await publishedDraft(guild.id, 'rl-1')

    const interaction = fakeExecuteInteraction('rl-1', draft.id)
    await cancelCommand.execute(interaction as never, deps())

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true })
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('cancelled'))
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('CANCELLED')
  })

  it("refuse d'annuler l'annonce d'un tiers : message lisible, l'annonce reste publiée", async () => {
    const guild = await makeGuild(testDb)
    const draft = await publishedDraft(guild.id, 'rl-1')

    const interaction = fakeExecuteInteraction('intruder', draft.id)
    await cancelCommand.execute(interaction as never, deps())

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('not allowed'))
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('PUBLISHED')
  })
})

describe('/cancel autocomplete', () => {
  it("ne propose que les annonces publiées dont l'appelant est l'auteur", async () => {
    const guild = await makeGuild(testDb)
    const mine = await publishedDraft(guild.id, 'rl-1', 'Nerub-ar Palace')
    await publishedDraft(guild.id, 'other-rl', 'Liberation of Undermine') // pas le mien
    const draftMine = await testDb.event.create({ // le mien, mais encore en brouillon
      data: {
        originGuildId: guild.id, authorId: 'rl-1', authorContact: 'RaidLead#1234',
        raidName: 'Amirdrassil', difficulty: 'MYTHIC', scheduledAt: new Date('2026-09-02T19:00:00Z'),
      },
    })

    const respond = vi.fn().mockResolvedValue(undefined)
    await cancelCommand.autocomplete({ user: { id: 'rl-1' }, respond }, deps())

    expect(respond).toHaveBeenCalledTimes(1)
    const choices = respond.mock.calls[0]![0] as { name: string; value: string }[]
    expect(choices.map((c) => c.value)).toEqual([mine.id])
    expect(choices.map((c) => c.value)).not.toContain(draftMine.id)
    expect(choices[0]!.name).toBe('Nerub-ar Palace (HEROIC)')
  })

  it('respecte la limite Discord de 25 choix', async () => {
    const guild = await makeGuild(testDb)
    for (let i = 0; i < 30; i++) {
      const draft = await testDb.event.create({
        data: {
          originGuildId: guild.id, authorId: 'rl-1', authorContact: 'RaidLead#1234',
          raidName: `Raid ${i}`, difficulty: 'NORMAL',
          scheduledAt: new Date(Date.UTC(2026, 8, 1 + i, 19)),
        },
      })
      await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
      await publishEvent(testDb, draft.id)
    }

    const respond = vi.fn().mockResolvedValue(undefined)
    await cancelCommand.autocomplete({ user: { id: 'rl-1' }, respond }, deps())

    const choices = respond.mock.calls[0]![0] as { name: string; value: string }[]
    expect(choices).toHaveLength(25)
  })
})
