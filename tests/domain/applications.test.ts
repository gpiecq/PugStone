import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent, cancelEvent } from '../../src/domain/events.js'
import { validateApplicationInput, submitApplication, acceptApplication, openSlots } from '../../src/domain/applications.js'
import { SlotAlreadyFilled, NotAuthorized, EventClosed } from '../../src/domain/errors.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const input = { ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://www.warcraftlogs.com/character/eu/hyjal/pug' }

async function setup(slots = 1) {
  const guild = await makeGuild(testDb)
  const draft = await makeDraft(testDb, guild.id)
  const created = []
  for (let i = 0; i < slots; i++) created.push(await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' }))
  await publishEvent(testDb, draft.id)
  return { event: draft, slots: created }
}

const apply = (slotId: string, applicantId: string) =>
  submitApplication(testDb, {
    slotId, applicantId, applicantTag: applicantId,
    ignRealm: input.ignRealm, itemLevel: 626, logsUrl: input.logsUrl, comment: null,
  })

describe('validation de la saisie', () => {
  it('accepte une candidature complète', () => {
    const result = validateApplicationInput(input)
    expect(result.ok && result.value.itemLevel).toBe(626)
  })

  it('refuse un iLvl non numérique ou hors plage, en le disant', () => {
    for (const itemLevel of ['abc', '10', '9999']) {
      const result = validateApplicationInput({ ...input, itemLevel })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.errors.join(' ')).toMatch(/item level/i)
    }
  })

  it('refuse un lien qui n\'est pas sur warcraftlogs.com', () => {
    const result = validateApplicationInput({ ...input, logsUrl: 'https://exemple.com/x' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.join(' ')).toMatch(/warcraftlogs/i)
  })

  it('I5 — accepte les sous-domaines légitimes de warcraftlogs.com (classic, fresh)', () => {
    for (const host of ['classic.warcraftlogs.com', 'fresh.warcraftlogs.com', 'www.warcraftlogs.com', 'warcraftlogs.com']) {
      const result = validateApplicationInput({ ...input, logsUrl: `https://${host}/character/eu/hyjal/pug` })
      expect(result.ok, `${host} devrait être accepté`).toBe(true)
    }
  })

  it('I5 — refuse un lien warcraftlogs en http (non chiffré)', () => {
    const result = validateApplicationInput({ ...input, logsUrl: 'http://www.warcraftlogs.com/character/eu/hyjal/pug' })
    expect(result.ok).toBe(false)
  })

  it('I5 — refuse un domaine qui se contente de finir par warcraftlogs.com', () => {
    const result = validateApplicationInput({ ...input, logsUrl: 'https://warcraftlogs.com.evil.tld/x' })
    expect(result.ok).toBe(false)
  })

  it('accumule toutes les erreurs en une seule réponse', () => {
    const result = validateApplicationInput({ ignRealm: '', itemLevel: 'x', logsUrl: 'nope' })
    expect(!result.ok && result.errors).toHaveLength(3)
  })
})

describe('candidature', () => {
  it('enregistre la candidature et incrémente uniquement la version dashboard', async () => {
    const { event, slots } = await setup()
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    await apply(slots[0]!.id, 'p1')
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.dashboardVersion).toBe(before.dashboardVersion + 1)
    expect(after.publicVersion).toBe(before.publicVersion)
  })

  it('met à jour la candidature existante au lieu d\'en créer une seconde', async () => {
    const { slots } = await setup()
    await apply(slots[0]!.id, 'p1')
    await submitApplication(testDb, {
      slotId: slots[0]!.id, applicantId: 'p1', applicantTag: 'p1',
      ignRealm: 'Pug-Kazzak', itemLevel: 630, logsUrl: input.logsUrl, comment: 'maj',
    })
    const rows = await testDb.application.findMany({ where: { slotId: slots[0]!.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.itemLevel).toBe(630)
  })

  it('refuse une candidature sur une place déjà pourvue', async () => {
    // Deux places : la première se remplit sans clore l'annonce (la seconde
    // reste OPEN), pour isoler SlotAlreadyFilled d'EventClosed — avec une
    // seule place, remplir l'unique place complète aussi l'annonce, et
    // l'ordre de verrous Event -> Slot (I1) ferait alors remonter EventClosed
    // en premier, ce qui est correct mais ne teste plus ce que ce cas vise.
    const { slots } = await setup(2)
    const app = await apply(slots[0]!.id, 'p1')
    await acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' })
    await expect(apply(slots[0]!.id, 'p2')).rejects.toBeInstanceOf(SlotAlreadyFilled)
  })
})

describe('acceptation', () => {
  it('retient un candidat, écarte les autres et pourvoit la place', async () => {
    const { slots } = await setup()
    const a = await apply(slots[0]!.id, 'p1')
    await apply(slots[0]!.id, 'p2')
    const result = await acceptApplication(testDb, { applicationId: a.id, actorId: 'rl-1' })

    expect(result.applicantId).toBe('p1')
    expect(result.eventCompleted).toBe(true)
    const slot = await testDb.slot.findUniqueOrThrow({ where: { id: slots[0]!.id } })
    expect(slot.status).toBe('FILLED')
    expect(slot.acceptedApplicationId).toBe(a.id)
    const discarded = await testDb.application.findMany({ where: { status: 'DISCARDED' } })
    expect(discarded).toHaveLength(1)
  })

  it('ne clôt l\'annonce que lorsque toutes les places sont pourvues', async () => {
    const { event, slots } = await setup(2)
    const first = await apply(slots[0]!.id, 'p1')
    const result = await acceptApplication(testDb, { applicationId: first.id, actorId: 'rl-1' })
    expect(result.eventCompleted).toBe(false)
    expect((await testDb.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PUBLISHED')

    const second = await apply(slots[1]!.id, 'p2')
    await acceptApplication(testDb, { applicationId: second.id, actorId: 'rl-1' })
    expect((await testDb.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('COMPLETED')
  })

  it('renseigne closedAt uniquement quand l\'acceptation clôt l\'annonce', async () => {
    const { event, slots } = await setup(2)
    const first = await apply(slots[0]!.id, 'p1')
    await acceptApplication(testDb, { applicationId: first.id, actorId: 'rl-1' })
    const stillOpen = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(stillOpen.closedAt).toBeNull()

    const before = Date.now()
    const second = await apply(slots[1]!.id, 'p2')
    await acceptApplication(testDb, { applicationId: second.id, actorId: 'rl-1' })
    const after = Date.now()

    const completed = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(completed.status).toBe('COMPLETED')
    expect(completed.closedAt).not.toBeNull()
    expect(completed.closedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(completed.closedAt!.getTime()).toBeLessThanOrEqual(after + 1000)
  })

  it('incrémente les deux compteurs de version', async () => {
    const { event, slots } = await setup()
    const app = await apply(slots[0]!.id, 'p1')
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    await acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' })
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.publicVersion).toBeGreaterThan(before.publicVersion)
    expect(after.dashboardVersion).toBeGreaterThan(before.dashboardVersion)
  })

  it('refuse l\'acceptation par quelqu\'un d\'autre que l\'auteur', async () => {
    const { slots } = await setup()
    const app = await apply(slots[0]!.id, 'p1')
    await expect(acceptApplication(testDb, { applicationId: app.id, actorId: 'intrus' }))
      .rejects.toBeInstanceOf(NotAuthorized)
  })
})

describe('concurrence', () => {
  it('n\'accepte qu\'un seul candidat sur deux acceptations simultanées', async () => {
    const { slots } = await setup()
    const a = await apply(slots[0]!.id, 'p1')
    const b = await apply(slots[0]!.id, 'p2')

    const results = await Promise.allSettled([
      acceptApplication(testDb, { applicationId: a.id, actorId: 'rl-1' }),
      acceptApplication(testDb, { applicationId: b.id, actorId: 'rl-1' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await testDb.application.count({ where: { status: 'ACCEPTED' } })).toBe(1)
  })

  it('sérialise deux candidatures simultanées sur la dernière place', async () => {
    const { slots } = await setup()
    const results = await Promise.allSettled([apply(slots[0]!.id, 'p1'), apply(slots[0]!.id, 'p2')])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(await testDb.application.count()).toBe(results.filter((r) => r.status === 'fulfilled').length)
  })

  it('accepte deux candidatures simultanées sur les deux dernières places et clôt l\'annonce', async () => {
    const { event, slots } = await setup(6)
    const apps = await Promise.all(slots.map((s, i) => apply(s.id, `p${i}`)))

    const results = await Promise.allSettled(
      apps.map((a) => acceptApplication(testDb, { applicationId: a.id, actorId: 'rl-1' })),
    )

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const finalEvent = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(finalEvent.status).toBe('COMPLETED')
    const stillOpen = await testDb.slot.count({ where: { eventId: event.id, status: 'OPEN' } })
    expect(stillOpen).toBe(0)
  })

  it('une annulation concurrente d\'une acceptation ne laisse jamais l\'annonce repasser de CANCELLED à COMPLETED', async () => {
    const { event, slots } = await setup()
    const app = await apply(slots[0]!.id, 'p1')

    const [acceptResult, cancelResult] = await Promise.allSettled([
      acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' }),
      cancelEvent(testDb, event.id, 'rl-1'),
    ])

    // cancelEvent n'a aucune raison d'échouer ici (même auteur, annonce existante) :
    // il gagne toujours la course en dernier ressort, l'annonce doit donc finir
    // CANCELLED — jamais COMPLETED, ce qui serait une régression CANCELLED -> COMPLETED.
    expect(cancelResult.status).toBe('fulfilled')
    const finalEvent = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(finalEvent.status).toBe('CANCELLED')

    const finalSlot = await testDb.slot.findUniqueOrThrow({ where: { id: slots[0]!.id } })
    const finalApp = await testDb.application.findUniqueOrThrow({ where: { id: app.id } })

    if (acceptResult.status === 'fulfilled') {
      // L'acceptation a gagné la course sur le verrou d'annonce : elle a légitimement
      // rempli la place avant que l'annulation ne soit committée.
      expect(finalSlot.status).toBe('FILLED')
      expect(finalSlot.acceptedApplicationId).toBe(app.id)
      expect(finalApp.status).toBe('ACCEPTED')
    } else {
      // L'annulation a gagné : l'acceptation doit être refusée, sans avoir touché
      // ni la place ni la candidature.
      expect(acceptResult.reason).toBeInstanceOf(EventClosed)
      expect(finalSlot.status).toBe('OPEN')
      expect(finalSlot.acceptedApplicationId).toBeNull()
      expect(finalApp.status).toBe('PENDING')
    }
  })
})

describe('openSlots', () => {
  it('ne rend que les places encore ouvertes', async () => {
    const { event, slots } = await setup(2)
    const app = await apply(slots[0]!.id, 'p1')
    await acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' })
    const open = await openSlots(testDb, event.id)
    expect(open.map((s) => s.id)).toEqual([slots[1]!.id])
  })
})
