import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { FakeGateway, discordError } from '../helpers/fake-gateway.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { runOutboxTick, backoffDelayMs, MAX_ATTEMPTS } from '../../src/broadcast/outbox.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>' }
// `EventMessage.nextAttemptAt` a `@default(now())` : les lignes créées par
// `publishEvent` reçoivent l'horloge murale réelle de Postgres au moment de
// l'insertion. L'horloge simulée du worker doit donc démarrer après cette
// horloge réelle (marge large pour couvrir toute la durée de la suite), sans
// quoi aucune ligne fraîche ne serait jamais éligible au premier tick.
let clock = new Date(Date.now() + 24 * 60 * 60 * 1000)
const deps = (gateway: FakeGateway) => ({ db: testDb, gateway, emojis, now: () => clock })

async function publishedEvent() {
  const origin = await makeGuild(testDb, { discordGuildId: 'origin' })
  await makeGuild(testDb, { discordGuildId: 'partner' })
  const draft = await makeDraft(testDb, origin.id)
  await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
  await publishEvent(testDb, draft.id)
  return draft
}

describe('publication initiale', () => {
  it('envoie un message par cible et mémorise les identifiants', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    const result = await runOutboxTick(deps(gateway))

    expect(result.processed).toBe(3) // 2 publics + 1 dashboard
    expect(gateway.sent).toHaveLength(2)
    expect(gateway.dms).toHaveLength(1)
    const rows = await testDb.eventMessage.findMany({ where: { eventId: event.id } })
    expect(rows.every((r) => r.messageId !== null && r.syncedVersion === 1)).toBe(true)
  })

  it('ne fait rien au tick suivant si rien n\'a changé', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))
    const second = await runOutboxTick(deps(gateway))
    expect(second.processed).toBe(0)
    expect(gateway.edited).toHaveLength(0)
  })
})

describe('mises à jour', () => {
  it('édite les messages existants quand la version publique augmente', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    await testDb.event.update({ where: { id: event.id }, data: { publicVersion: { increment: 1 } } })
    await runOutboxTick(deps(gateway))
    expect(gateway.edited).toHaveLength(2)
    expect(gateway.sent).toHaveLength(2) // aucun nouvel envoi
  })

  it('coalesce plusieurs changements en une seule édition', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    await testDb.event.update({ where: { id: event.id }, data: { publicVersion: { increment: 3 } } })
    await runOutboxTick(deps(gateway))
    expect(gateway.edited).toHaveLength(2)
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.syncedVersion === 4)).toBe(true)
  })

  it('n\'édite pas le message public quand seul le dashboard a changé', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    await testDb.event.update({ where: { id: event.id }, data: { dashboardVersion: { increment: 1 } } })
    await runOutboxTick(deps(gateway))
    expect(gateway.edited).toHaveLength(1)
    expect(gateway.edited[0]!.channelId).toBe('dm-rl-1')
  })
})

describe('échecs', () => {
  it('replanifie avec backoff sur erreur transitoire', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(500))
    const result = await runOutboxTick(deps(gateway))

    expect(result.failed).toBe(3)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { kind: 'PUBLIC' } })
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(clock.getTime())
    expect(row.lastError).toContain('500')
  })

  it('ignore les lignes dont le prochain essai est dans le futur', async () => {
    await publishedEvent()
    const failing = new FakeGateway()
    failing.failAlways(discordError(500))
    await runOutboxTick(deps(failing))

    const gateway = new FakeGateway()
    const result = await runOutboxTick(deps(gateway))
    expect(result.processed).toBe(0)
  })

  it('abandonne après MAX_ATTEMPTS tentatives', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(500))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runOutboxTick(deps(gateway))
      clock = new Date(clock.getTime() + 60 * 60 * 1000)
    }
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.disabled)).toBe(true)
  })

  it('marque le serveur NEEDS_ATTENTION sur permission manquante, sans réessayer', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(50013))
    await runOutboxTick(deps(gateway))

    const guild = await testDb.guild.findUniqueOrThrow({ where: { discordGuildId: 'partner' } })
    expect(guild.status).toBe('NEEDS_ATTENTION')
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { guildId: 'partner' } })
    expect(row.disabled).toBe(true)
  })

  it('désactive la ligne sans republier quand le message a été supprimé', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))
    await testDb.event.update({ where: { id: event.id }, data: { publicVersion: { increment: 1 } } })

    const gone = new FakeGateway()
    gone.failAlways(discordError(10008))
    await runOutboxTick(deps(gone))

    expect(gone.sent).toHaveLength(0)
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.disabled)).toBe(true)
  })

  it('bascule le dashboard sur un thread privé quand les DM sont fermés', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failNext(discordError(50007)) // Cannot send messages to this user
    await runOutboxTick(deps(gateway))

    expect(gateway.threads).toHaveLength(1)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { kind: 'DASHBOARD' } })
    expect(row.channelId).toBe('thread-chan')
    expect(row.messageId).not.toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('croît de façon exponentielle et reste borné', () => {
    expect(backoffDelayMs(1)).toBeGreaterThanOrEqual(5_000)
    expect(backoffDelayMs(3)).toBeGreaterThan(backoffDelayMs(1))
    expect(backoffDelayMs(20)).toBeLessThanOrEqual(30 * 60 * 1000)
  })
})
