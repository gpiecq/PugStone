import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { createDraft, addSlot, removeSlot, setContact, publishEvent, cancelEvent, loadEventView } from '../../src/domain/events.js'
import { EmptyRoster, NoActivePartners, NotAuthorized } from '../../src/domain/errors.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

describe('brouillon', () => {
  it('createDraft persiste chaque champ transmis sans les confondre entre eux', async () => {
    const guild = await makeGuild(testDb)
    const scheduledAt = new Date('2026-10-15T20:30:00Z')
    const draft = await createDraft(testDb, {
      originGuildId: guild.id,
      authorId: 'author-distinct',
      raidName: 'Liberation of Undermine',
      difficulty: 'MYTHIC',
      scheduledAt,
    })

    const reloaded = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(reloaded.originGuildId).toBe(guild.id)
    expect(reloaded.authorId).toBe('author-distinct')
    expect(reloaded.raidName).toBe('Liberation of Undermine')
    expect(reloaded.difficulty).toBe('MYTHIC')
    expect(reloaded.scheduledAt).toEqual(scheduledAt)
    expect(reloaded.status).toBe('DRAFT')
  })

  it('setContact met à jour authorContact et un second appel remplace la valeur précédente', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)

    await setContact(testDb, draft.id, 'RaidLead#1234')
    const first = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(first.authorContact).toBe('RaidLead#1234')

    await setContact(testDb, draft.id, 'discord.gg/nouveau-contact')
    const second = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(second.authorContact).toBe('discord.gg/nouveau-contact')
  })
})

describe('construction du roster', () => {
  it('déduit le rôle de la spé et incrémente la position', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const tank = await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    const dps = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    expect(tank.role).toBe('TANK')
    expect(dps.position).toBe(1)
  })

  it('accepte deux fois la même spé — une ligne par place', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    expect(await testDb.slot.count({ where: { eventId: draft.id } })).toBe(2)
  })

  it('refuse une spé inconnue', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await expect(addSlot(testDb, draft.id, { className: 'MAGE', specName: 'BLOOD' })).rejects.toThrow()
  })

  it('retire une place du brouillon', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await removeSlot(testDb, slot.id)
    expect(await testDb.slot.count({ where: { eventId: draft.id } })).toBe(0)
  })
})

describe('publication', () => {
  it('crée une ligne d\'émission par partenaire actif plus le dashboard', async () => {
    const origin = await makeGuild(testDb, { discordGuildId: 'origin' })
    await makeGuild(testDb, { discordGuildId: 'partner-1' })
    await makeGuild(testDb, { discordGuildId: 'partner-2' })
    await makeGuild(testDb, { discordGuildId: 'sans-salon', lfgChannelId: null })

    const draft = await makeDraft(testDb, origin.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    const { targets } = await publishEvent(testDb, draft.id)

    expect(targets).toBe(3) // origin + 2 partenaires, le serveur sans salon est exclu
    expect(await testDb.eventMessage.count({ where: { kind: 'PUBLIC' } })).toBe(3)
    expect(await testDb.eventMessage.count({ where: { kind: 'DASHBOARD' } })).toBe(1)
    const published = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(published.status).toBe('PUBLISHED')
    expect(published.publicVersion).toBe(1)
  })

  it('refuse un roster vide et laisse l\'annonce en brouillon', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await expect(publishEvent(testDb, draft.id)).rejects.toBeInstanceOf(EmptyRoster)
    const untouched = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(untouched.status).toBe('DRAFT')
    expect(await testDb.eventMessage.count()).toBe(0)
  })

  it('refuse la publication si aucun partenaire n\'a de salon configuré', async () => {
    const guild = await makeGuild(testDb, { lfgChannelId: null })
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await expect(publishEvent(testDb, draft.id)).rejects.toBeInstanceOf(NoActivePartners)
  })
})

describe('annulation', () => {
  it('passe l\'annonce en CANCELLED et incrémente la version publique', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    await cancelEvent(testDb, draft.id, 'rl-1')
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('CANCELLED')
    expect(event.publicVersion).toBe(2)
  })

  it('renseigne closedAt à l\'instant de l\'annulation', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)

    const before = Date.now()
    await cancelEvent(testDb, draft.id, 'rl-1')
    const after = Date.now()

    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.closedAt).not.toBeNull()
    expect(event.closedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(event.closedAt!.getTime()).toBeLessThanOrEqual(after + 1000)
  })

  it('refuse l\'annulation par un tiers', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await expect(cancelEvent(testDb, draft.id, 'intrus')).rejects.toBeInstanceOf(NotAuthorized)
  })
})

describe('loadEventView', () => {
  it('rend les places ordonnées avec leurs candidatures en attente', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await testDb.application.create({
      data: {
        slotId: slot.id, applicantId: 'p1', applicantTag: 'Pug', ignRealm: 'Pug-Hyjal',
        itemLevel: 626, logsUrl: 'https://warcraftlogs.com/x',
      },
    })
    const view = await loadEventView(testDb, draft.id)
    expect(view.slots).toHaveLength(1)
    expect(view.slots[0]!.applications).toHaveLength(1)
  })
})
