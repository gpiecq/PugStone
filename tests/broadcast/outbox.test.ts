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
const deps = (gateway: FakeGateway) => ({ db: testDb, gateway, emojis, now: () => clock, ownerId: 'bot-owner' })

async function publishedEvent() {
  const origin = await makeGuild(testDb, { discordGuildId: 'origin' })
  await makeGuild(testDb, { discordGuildId: 'partner' })
  const draft = await makeDraft(testDb, origin.id)
  await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
  await publishEvent(testDb, draft.id)
  return draft
}

// Une seule ligne PUBLIC, sans ligne DASHBOARD : évite toute interférence
// entre les appels `sendDM` du dashboard (Raid Leader) et ceux des
// notifications de la Tâche 19, qui partagent la même file de FakeGateway.
async function publicOnlyMessage(guildId: string, channelId: string) {
  const origin = await makeGuild(testDb)
  const event = await testDb.event.create({
    data: {
      originGuildId: origin.id, authorId: 'author', authorContact: 'RaidLead#0001',
      raidName: 'Liberation of Undermine', difficulty: 'HEROIC',
      scheduledAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: 'PUBLISHED', publicVersion: 1,
    },
  })
  await testDb.eventMessage.create({ data: { eventId: event.id, guildId, channelId, kind: 'PUBLIC' } })
  return event
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
    // Ligne PUBLIC isolée (pas `publishedEvent()`) : depuis la Tâche 19, une
    // erreur générique (500) sur `sendMessage`/`sendDM` déclenche aussi une
    // notification, elle-même émise via `sendDM`. `failAlways` échouerait
    // donc également cette notification et polluerait la sortie de test de
    // `logger.warn` — on cible précisément les appels dont ce test a besoin.
    await publicOnlyMessage('origin', 'chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', ...Array(MAX_ATTEMPTS).fill(discordError(500)))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runOutboxTick(deps(gateway))
      clock = new Date(clock.getTime() + 60 * 60 * 1000)
    }
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.disabled)).toBe(true)
  })

  it('marque le serveur NEEDS_ATTENTION sur permission manquante, sans réessayer', async () => {
    // Idem : ligne PUBLIC isolée plutôt que `failAlways`, pour que la
    // notification déclenchée (fetchGuildOwnerId + sendDM) réussisse
    // silencieusement au lieu de polluer la sortie de `logger.warn`.
    await makeGuild(testDb, { discordGuildId: 'partner', lfgChannelId: 'partner-chan' })
    await publicOnlyMessage('partner', 'partner-chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', discordError(50013))
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
    // Ciblé sur sendDM (pas failNext) : le worker traite toutes les lignes
    // réclamées en une seule passe parallèle, sans ordre garanti entre
    // dashboard et diffusion publique — seule la ligne DASHBOARD doit être
    // affectée par cette erreur.
    gateway.failNextOn('sendDM', discordError(50007)) // Cannot send messages to this user
    await runOutboxTick(deps(gateway))

    expect(gateway.threads).toHaveLength(1)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { kind: 'DASHBOARD' } })
    expect(row.channelId).toBe('thread-chan')
    expect(row.messageId).not.toBeNull()
  })
})

describe('notifications d\'échec (Tâche 19)', () => {
  it('un échec 50013 notifie le propriétaire du serveur partenaire et l\'owner du bot', async () => {
    await makeGuild(testDb, { discordGuildId: 'partner', lfgChannelId: 'partner-chan' })
    await publicOnlyMessage('partner', 'partner-chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', discordError(50013))
    await runOutboxTick(deps(gateway))

    expect(gateway.dms.filter((d) => d.userId === 'owner-partner')).toHaveLength(1)
    expect(gateway.dms.filter((d) => d.userId === 'bot-owner')).toHaveLength(1)
    const guild = await testDb.guild.findUniqueOrThrow({ where: { discordGuildId: 'partner' } })
    expect(guild.status).toBe('NEEDS_ATTENTION')
  })

  it('ne notifie pas de nouveau un serveur déjà NEEDS_ATTENTION (anti-spam entre ticks)', async () => {
    await makeGuild(testDb, { discordGuildId: 'partner', lfgChannelId: 'partner-chan' })
    await publicOnlyMessage('partner', 'partner-chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', discordError(50013))
    await runOutboxTick(deps(gateway))

    // Une seconde annonce, publiée directement en base (le fan-out normal
    // exclurait désormais ce serveur, plus ACTIVE) : simule un second échec
    // touchant un serveur déjà marqué.
    await publicOnlyMessage('partner', 'partner-chan')
    gateway.failNextOn('sendMessage', discordError(50013))
    await runOutboxTick(deps(gateway))

    expect(gateway.dms.filter((d) => d.userId === 'owner-partner')).toHaveLength(1)
    expect(gateway.dms.filter((d) => d.userId === 'bot-owner')).toHaveLength(1)
  })

  it('ne notifie qu\'une fois pour deux lignes du même serveur traitées dans le même tick', async () => {
    await makeGuild(testDb, { discordGuildId: 'partner', lfgChannelId: 'partner-chan' })
    await publicOnlyMessage('partner', 'partner-chan')
    await publicOnlyMessage('partner', 'partner-chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', discordError(50013), discordError(50013))
    await runOutboxTick(deps(gateway))

    expect(gateway.dms.filter((d) => d.userId === 'owner-partner')).toHaveLength(1)
    expect(gateway.dms.filter((d) => d.userId === 'bot-owner')).toHaveLength(1)
    const rows = await testDb.eventMessage.findMany({ where: { guildId: 'partner' } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.disabled)).toBe(true)
  })

  it('notifie l\'owner du bot pour chaque ligne abandonnée après MAX_ATTEMPTS', async () => {
    // Deux lignes PUBLIC, sans DASHBOARD : `failAlways` ferait aussi échouer
    // les DM de notification eux-mêmes (même gateway, aucune distinction de
    // méthode), rendant le scénario invérifiable. On cible donc précisément
    // les MAX_ATTEMPTS échecs de `sendMessage` par ligne dont ce test a besoin,
    // en laissant `sendDM` (celui des notifications) libre de réussir.
    await publicOnlyMessage('guildA', 'chanA')
    await publicOnlyMessage('guildB', 'chanB')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', ...Array(2 * MAX_ATTEMPTS).fill(discordError(500)))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runOutboxTick(deps(gateway))
      clock = new Date(clock.getTime() + 60 * 60 * 1000)
    }
    const rows = await testDb.eventMessage.findMany({})
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.disabled)).toBe(true)
    expect(gateway.dms.filter((d) => d.userId === 'bot-owner')).toHaveLength(2)
  })

  it('un échec de sendDM pendant la notification n\'empêche pas le traitement du tick', async () => {
    await makeGuild(testDb, { discordGuildId: 'partner', lfgChannelId: 'partner-chan' })
    const event = await publicOnlyMessage('partner', 'partner-chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', discordError(50013))
    gateway.failNextOn('sendDM', discordError(500), discordError(500))

    const result = await runOutboxTick(deps(gateway))

    expect(result.failed).toBe(1)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { eventId: event.id } })
    expect(row.disabled).toBe(true)
    const guild = await testDb.guild.findUniqueOrThrow({ where: { discordGuildId: 'partner' } })
    expect(guild.status).toBe('NEEDS_ATTENTION')
    // Ne pas se contenter d'observer l'absence d'exception : une version du
    // code sans aucune notification satisferait tout autant les assertions
    // ci-dessus. On épingle donc la tentative elle-même — le propriétaire du
    // serveur a bien été résolu — et son échec — aucun DM de notification
    // n'a abouti, malgré les 2 files `sendDM` réellement consommées.
    expect(gateway.guildOwnerFetches).toContain('partner')
    expect(gateway.dms.filter((d) => d.userId === 'owner-partner' || d.userId === 'bot-owner')).toHaveLength(0)
  })

  it('un échec 50001 sur une ligne DASHBOARD ne dégrade pas le serveur émetteur', async () => {
    // deliverDashboard relance TARGET_UNUSABLE dès l'échec du DM initial au
    // Raid Leader, avant toute tentative sur le salon LFG d'origine : ce
    // n'est jamais le serveur qui est en cause, seulement l'accessibilité
    // d'un joueur précis (revue Tâche 19). Le serveur émetteur doit donc
    // rester ACTIVE et son propriétaire ne doit rien recevoir.
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failNextOn('sendDM', discordError(50001))
    await runOutboxTick(deps(gateway))

    const origin = await testDb.guild.findUniqueOrThrow({ where: { discordGuildId: 'origin' } })
    expect(origin.status).toBe('ACTIVE')
    expect(gateway.dms.filter((d) => d.userId === 'owner-origin')).toHaveLength(0)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { kind: 'DASHBOARD' } })
    expect(row.disabled).toBe(true)
    // L'owner du bot, lui, est bien informé que ce dashboard précis n'a pas pu être livré.
    expect(gateway.dms.filter((d) => d.userId === 'bot-owner')).toHaveLength(1)
  })

  it('un échec de fetchGuildOwnerId est traité comme les autres : l\'owner du bot est tout de même prévenu', async () => {
    await makeGuild(testDb, { discordGuildId: 'partner', lfgChannelId: 'partner-chan' })
    await publicOnlyMessage('partner', 'partner-chan')
    const gateway = new FakeGateway()
    gateway.failNextOn('sendMessage', discordError(50013))
    gateway.failNextOn('fetchGuildOwnerId', discordError(500))

    await expect(runOutboxTick(deps(gateway))).resolves.toEqual({ processed: 0, failed: 1 })

    expect(gateway.dms.filter((d) => d.userId === 'owner-partner')).toHaveLength(0)
    expect(gateway.dms.filter((d) => d.userId === 'bot-owner')).toHaveLength(1)
  })

  it('un tick nominal sans échec n\'envoie aucune notification (non-régression)', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    expect(gateway.dms.some((d) => d.userId === 'bot-owner' || d.userId.startsWith('owner-'))).toBe(false)
  })
})

describe('backoffDelayMs', () => {
  it('croît de façon exponentielle et reste borné', () => {
    expect(backoffDelayMs(1)).toBeGreaterThanOrEqual(5_000)
    expect(backoffDelayMs(3)).toBeGreaterThan(backoffDelayMs(1))
    expect(backoffDelayMs(20)).toBeLessThanOrEqual(30 * 60 * 1000)
  })
})
