import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { submitApplication } from '../../src/domain/applications.js'
import { FakeGateway, discordError } from '../helpers/fake-gateway.js'
import { notifyAccepted, registerDashboardHandlers } from '../../src/interactions/dashboard.js'
import { dispatchInteraction, resetHandlers, type BotDeps } from '../../src/bot/router.js'
import { buildCustomId } from '../../src/broadcast/render.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const accepted = { applicantId: 'p1', contact: 'RaidLead#1234', raidName: 'Nerub-ar Palace' }

describe('notification du candidat retenu', () => {
  it('envoie un DM contenant le raid et le contact du RL', async () => {
    const gateway = new FakeGateway()
    const result = await notifyAccepted(gateway, accepted)
    expect(result.delivered).toBe(true)
    expect(gateway.dms[0]!.payload.content).toContain('Nerub-ar Palace')
    expect(gateway.dms[0]!.payload.content).toContain('RaidLead#1234')
  })

  it('signale l\'échec sans lever quand le joueur a fermé ses DM', async () => {
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(50007))
    const result = await notifyAccepted(gateway, accepted)
    expect(result.delivered).toBe(false)
  })
})

// Double minimal d'interaction, dans le même esprit que tests/interactions/roster.test.ts
// et apply.test.ts : uniquement ce dont dispatchInteraction et les handlers du
// dashboard ont besoin (customId, user.id, values pour le select d'acceptation,
// deferReply/editReply pour la réponse éphémère différée).
function fakeInteraction(customId: string, userId: string, values?: string[]) {
  return {
    customId,
    user: { id: userId },
    values,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  }
}

function deps(gateway: FakeGateway): BotDeps {
  return { db: testDb, gateway, emojis: {}, ownerId: 'owner' }
}

async function makeApplication(slotId: string, applicantId = 'player-1') {
  return submitApplication(testDb, {
    slotId, applicantId, applicantTag: `${applicantId}#0001`,
    ignRealm: 'Pug-Hyjal', itemLevel: 626, logsUrl: 'https://www.warcraftlogs.com/x', comment: null,
  })
}

describe('dash:accept', () => {
  beforeEach(() => {
    resetHandlers()
    registerDashboardHandlers()
  })

  it('refuse un non-auteur : NotAuthorized, aucune candidature acceptée, aucun DM envoyé', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    const application = await makeApplication(slot.id)

    const gateway = new FakeGateway()
    const interaction = fakeInteraction(buildCustomId('dash', 'accept', draft.id), 'intruder', [application.id])
    await dispatchInteraction(interaction as never, deps(gateway) as never)

    expect(interaction.editReply).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not allowed') }))
    expect(gateway.dms).toHaveLength(0)
    const stored = await testDb.application.findUniqueOrThrow({ where: { id: application.id } })
    expect(stored.status).toBe('PENDING')
  })

  it("l'auteur accepte un candidat : la place est pourvue, le candidat est notifié par DM", async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    const application = await makeApplication(slot.id, 'player-1')

    const gateway = new FakeGateway()
    const interaction = fakeInteraction(buildCustomId('dash', 'accept', draft.id), 'rl-1', [application.id])
    await dispatchInteraction(interaction as never, deps(gateway) as never)

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true })
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('accepted and notified') }),
    )
    expect(gateway.dms).toHaveLength(1)
    expect(gateway.dms[0]!.userId).toBe('player-1')
    expect(gateway.dms[0]!.payload.content).toContain('Nerub-ar Palace')
    expect(gateway.dms[0]!.payload.content).toContain('RaidLead#1234')

    const storedApp = await testDb.application.findUniqueOrThrow({ where: { id: application.id } })
    expect(storedApp.status).toBe('ACCEPTED')
    const storedSlot = await testDb.slot.findUniqueOrThrow({ where: { id: slot.id } })
    expect(storedSlot.status).toBe('FILLED')
  })

  it("candidat retenu injoignable en DM : l'acceptation reste committée, le RL est prévenu de prendre le relais", async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    const application = await makeApplication(slot.id, 'player-1')

    const gateway = new FakeGateway()
    gateway.failAlways(discordError(50007))
    const interaction = fakeInteraction(buildCustomId('dash', 'accept', draft.id), 'rl-1', [application.id])
    await dispatchInteraction(interaction as never, deps(gateway) as never)

    // La transaction d'acceptation est déjà committée : le DM refusé ne doit
    // jamais la faire échouer, seul le message au RL change.
    const storedApp = await testDb.application.findUniqueOrThrow({ where: { id: application.id } })
    expect(storedApp.status).toBe('ACCEPTED')
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('<@player-1>') }),
    )
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('could not DM them') }),
    )
  })

  it('dernière place pourvue : l\'annonce est close et le message le signale', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    const application = await makeApplication(slot.id, 'player-1')

    const gateway = new FakeGateway()
    const interaction = fakeInteraction(buildCustomId('dash', 'accept', draft.id), 'rl-1', [application.id])
    await dispatchInteraction(interaction as never, deps(gateway) as never)

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('now closed') }),
    )
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('COMPLETED')
  })
})

describe('dash:close', () => {
  beforeEach(() => {
    resetHandlers()
    registerDashboardHandlers()
  })

  it('refuse un non-auteur : NotAuthorized, l\'annonce reste publiée', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)

    const gateway = new FakeGateway()
    const interaction = fakeInteraction(buildCustomId('dash', 'close', draft.id), 'intruder')
    await dispatchInteraction(interaction as never, deps(gateway) as never)

    expect(interaction.editReply).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not allowed') }))
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('PUBLISHED')
  })

  it('l\'auteur clôt son annonce : statut CANCELLED, message de confirmation', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)

    const gateway = new FakeGateway()
    const interaction = fakeInteraction(buildCustomId('dash', 'close', draft.id), 'rl-1')
    await dispatchInteraction(interaction as never, deps(gateway) as never)

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Listing closed') }))
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('CANCELLED')
  })
})
