// Parcours de candidature : bouton [⚔️ Apply] -> (select de rôle si plusieurs
// places ouvertes) -> modal -> soumission. La contrainte Discord centrale est
// qu'un modal doit être la toute première réponse à une interaction — les
// tests de app:open et app:role vérifient donc explicitement qu'aucun
// deferReply n'a lieu avant showModal.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent, cancelEvent } from '../../src/domain/events.js'
import { openSlots, submitApplication } from '../../src/domain/applications.js'
import {
  buildApplyModal,
  buildRoleSelect,
  readModalFields,
  registerApplyHandlers,
} from '../../src/interactions/apply.js'
import { dispatchInteraction, resetHandlers, type BotDeps } from '../../src/bot/router.js'
import { buildCustomId } from '../../src/broadcast/render.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>', PALADIN: '<:pala:2>' }

// Double minimal d'interaction, dans le même esprit que tests/interactions/roster.test.ts :
// uniquement ce dont dispatchInteraction et les handlers ont besoin. `deferReply` est
// présent pour pouvoir prouver son absence d'appel (contrainte Discord : le modal doit
// être la première réponse).
function fakeInteraction(customId: string, userId: string, values?: string[]) {
  return {
    customId,
    user: { id: userId, username: `${userId}#0001` },
    values,
    fields: { getTextInputValue: (_id: string) => '' } as { getTextInputValue(id: string): string },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
  }
}

function deps(): BotDeps {
  return { db: testDb, gateway: {} as never, emojis, ownerId: 'owner' }
}

describe('modal de candidature', () => {
  it('contient les quatre champs attendus, dont un seul optionnel', () => {
    const modal = buildApplyModal('s1', 'Arcane') as {
      custom_id: string
      components: { components: { custom_id: string; required: boolean; style: number }[] }[]
    }
    expect(modal.custom_id).toBe('pug:1:app:submit:s1')
    const fields = modal.components.map((row) => row.components[0]!)
    expect(fields.map((f) => f.custom_id)).toEqual(['ignRealm', 'itemLevel', 'logsUrl', 'comment'])
    expect(fields.filter((f) => f.required)).toHaveLength(3)
    expect(fields[3]!.style).toBe(2) // paragraphe
  })
})

describe('choix du rôle', () => {
  it('propose une option par place ouverte, avec le nom de la classe', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    await publishEvent(testDb, draft.id)

    const payload = buildRoleSelect(draft.id, await openSlots(testDb, draft.id), emojis)
    const select = (payload.components[0] as { components: { custom_id: string; options: { label: string }[] }[] }).components[0]!
    expect(select.custom_id).toBe(`pug:1:app:role:${draft.id}`)
    expect(select.options.map((o) => o.label)).toEqual(['Arcane (Mage)', 'Protection (Paladin)'])
  })
})

describe('lecture du modal', () => {
  it('extrait les champs et laisse le commentaire vide devenir null', () => {
    const fields = {
      getTextInputValue: (id: string) => ({ ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://warcraftlogs.com/x', comment: '  ' }[id] ?? ''),
    }
    expect(readModalFields(fields)).toEqual({
      ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://warcraftlogs.com/x', comment: null,
    })
  })
})

describe('app:open — première réponse à l\'interaction', () => {
  beforeEach(() => {
    resetHandlers()
    registerApplyHandlers()
  })

  it('une seule place ouverte : ouvre directement le modal, sans deferReply ni reply', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    const [slot] = await openSlots(testDb, draft.id)

    const interaction = fakeInteraction(buildCustomId('app', 'open', draft.id), 'player-1')
    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(interaction.reply).not.toHaveBeenCalled()
    expect(interaction.showModal).toHaveBeenCalledTimes(1)
    const modal = interaction.showModal.mock.calls[0]![0] as { custom_id: string }
    expect(modal.custom_id).toBe(buildCustomId('app', 'submit', slot!.id))
  })

  it('plusieurs places ouvertes : propose le select de rôle en éphémère, sans deferReply ni showModal', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    await publishEvent(testDb, draft.id)

    const interaction = fakeInteraction(buildCustomId('app', 'open', draft.id), 'player-1')
    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(interaction.showModal).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledTimes(1)
    const payload = interaction.reply.mock.calls[0]![0] as { ephemeral: boolean; components: unknown[] }
    expect(payload.ephemeral).toBe(true)
  })

  it('annonce close : message lisible, aucun modal ni select ouvert', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    await cancelEvent(testDb, draft.id, 'rl-1')

    const interaction = fakeInteraction(buildCustomId('app', 'open', draft.id), 'player-1')
    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.showModal).not.toHaveBeenCalled()
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('no longer accepting applications'),
      ephemeral: true,
    }))
  })

  it('n\'importe quel joueur peut postuler : aucun contrôle de propriété sur app:open', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id, 'rl-1')
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)

    // L'auteur de l'annonce (rl-1) lui-même est un candidat comme un autre ici :
    // il n'y a pas de raison métier de le distinguer, ce test le documente.
    const interaction = fakeInteraction(buildCustomId('app', 'open', draft.id), 'rl-1')
    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.showModal).toHaveBeenCalledTimes(1)
  })
})

describe('app:role', () => {
  beforeEach(() => {
    resetHandlers()
    registerApplyHandlers()
  })

  it('ouvre le modal pour la place choisie', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    await publishEvent(testDb, draft.id)
    const slots = await openSlots(testDb, draft.id)
    const chosen = slots[1]!

    const interaction = fakeInteraction(buildCustomId('app', 'role', draft.id), 'player-1', [chosen.id])
    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(interaction.showModal).toHaveBeenCalledTimes(1)
    const modal = interaction.showModal.mock.calls[0]![0] as { custom_id: string; title: string }
    expect(modal.custom_id).toBe(buildCustomId('app', 'submit', chosen.id))
    expect(modal.title).toContain('Protection')
  })
})

describe('app:submit', () => {
  beforeEach(() => {
    resetHandlers()
    registerApplyHandlers()
  })

  function fieldValues(values: Record<string, string>) {
    return {
      getTextInputValue: (id: string) => values[id] ?? '',
    }
  }

  it('saisie invalide : liste toutes les erreurs d\'un coup, aucune candidature créée', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)

    const interaction = fakeInteraction(buildCustomId('app', 'submit', slot.id), 'player-1')
    interaction.fields = fieldValues({ ignRealm: '', itemLevel: 'x', logsUrl: 'nope', comment: '' })

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.reply).toHaveBeenCalledTimes(1)
    const payload = interaction.reply.mock.calls[0]![0] as { content: string; ephemeral: boolean }
    expect(payload.ephemeral).toBe(true)
    expect(payload.content).toContain('not submitted')
    // Trois erreurs attendues (ignRealm, itemLevel, logsUrl) : le joueur doit
    // les voir toutes en une seule réponse, Discord ne conservant pas sa saisie.
    expect(payload.content.split('•')).toHaveLength(4) // préambule + 3 puces
    expect(await testDb.application.count()).toBe(0)
  })

  it('saisie valide : enregistre la candidature et confirme en éphémère', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)

    const interaction = fakeInteraction(buildCustomId('app', 'submit', slot.id), 'player-1')
    interaction.fields = fieldValues({
      ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://www.warcraftlogs.com/character/eu/hyjal/pug', comment: '',
    })

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
    const applications = await testDb.application.findMany({ where: { slotId: slot.id } })
    expect(applications).toHaveLength(1)
    expect(applications[0]!.applicantId).toBe('player-1')
    expect(applications[0]!.ignRealm).toBe('Pug-Hyjal')
  })

  it('place déjà pourvue : message lisible via le routeur, pas de doublon', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    // Une seconde place OPEN maintient l'annonce PUBLISHED une fois la
    // première pourvue : sinon l'annonce se clôt (EventClosed prend le pas
    // sur SlotAlreadyFilled avec l'ordre de verrous Event -> Slot, I1), ce
    // qui ne teste plus le message "just been filled" visé ici.
    await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    await publishEvent(testDb, draft.id)
    await submitApplication(testDb, {
      slotId: slot.id, applicantId: 'first', applicantTag: 'first',
      ignRealm: 'Pug-Hyjal', itemLevel: 626, logsUrl: 'https://www.warcraftlogs.com/x', comment: null,
    })
    const existing = await testDb.application.findFirstOrThrow({ where: { slotId: slot.id } })
    const { acceptApplication } = await import('../../src/domain/applications.js')
    await acceptApplication(testDb, { applicationId: existing.id, actorId: 'rl-1' })

    const interaction = fakeInteraction(buildCustomId('app', 'submit', slot.id), 'player-2')
    interaction.fields = fieldValues({
      ignRealm: 'Pug-Kazzak', itemLevel: '620', logsUrl: 'https://www.warcraftlogs.com/character/eu/kazzak/pug', comment: '',
    })

    await dispatchInteraction(interaction as never, deps() as never)

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('just been filled'),
      ephemeral: true,
    }))
    expect(await testDb.application.count({ where: { slotId: slot.id } })).toBe(1)
  })
})
