import { describe, it, expect } from 'vitest'
import { renderPublicMessage, renderDashboardMessage, escapeMarkdown } from '../../src/broadcast/render.js'
import type { EventView } from '../../src/domain/events.js'

const emojis = { MAGE: '<:mage:1>', PALADIN: '<:pala:2>' }

function view(overrides: Partial<EventView['event']> = {}, slots: Partial<EventView['slots'][number]>[] = []): EventView {
  return {
    event: {
      id: 'e1', originGuildId: 'g1', authorId: 'rl', authorContact: 'RL#1',
      raidName: 'Nerub-ar Palace', difficulty: 'HEROIC',
      scheduledAt: new Date('2026-09-01T19:00:00Z'), status: 'PUBLISHED',
      publicVersion: 1, dashboardVersion: 1, dashboardChannelId: null,
      dashboardMessageId: null, createdAt: new Date(), ...overrides,
    } as EventView['event'],
    slots: slots.map((s, i) => ({
      id: `s${i}`, eventId: 'e1', className: 'MAGE', specName: 'ARCANE', role: 'DPS',
      status: 'OPEN', acceptedApplicationId: null, position: i, applications: [], ...s,
    })) as EventView['slots'],
  }
}

describe('embed public', () => {
  it('affiche le titre, un timestamp dynamique et les places ouvertes', () => {
    const payload = renderPublicMessage(view({}, [{}]), emojis)
    const embed = payload.embeds[0] as { title: string; description: string }
    expect(embed.title).toBe('🚨 LFG - Nerub-ar Palace (Heroic)')
    expect(embed.description).toContain('<t:1788289200:F>') // instant du raid en secondes
    expect(embed.description).toContain('🔸 <:mage:1> Arcane (Open)')
  })

  it('agrège les places identiques et marque celles pourvues', () => {
    const payload = renderPublicMessage(view({}, [{}, {}, { status: 'FILLED' }]), emojis)
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description).toContain('🔸 <:mage:1> Arcane (2 Open)')
    expect(embed.description).toContain('✅ <:mage:1> Arcane (1 Filled)')
  })

  it('préfixe le titre et désactive le bouton quand l\'annonce est close', () => {
    for (const [status, prefix] of [['COMPLETED', '[COMPLETED]'], ['EXPIRED', '[EXPIRED]'], ['CANCELLED', '[CANCELLED]']] as const) {
      const payload = renderPublicMessage(view({ status }, [{ status: 'FILLED' }]), emojis)
      const embed = payload.embeds[0] as { title: string }
      const row = payload.components[0] as { components: { disabled: boolean }[] }
      expect(embed.title.startsWith(prefix)).toBe(true)
      expect(row.components[0]!.disabled).toBe(true)
    }
  })

  it('porte un bouton Apply actif référençant l\'annonce', () => {
    const payload = renderPublicMessage(view({}, [{}]), emojis)
    const row = payload.components[0] as { components: { custom_id: string; label: string; disabled: boolean }[] }
    expect(row.components[0]).toMatchObject({ custom_id: 'pug:1:app:open:e1', label: '⚔️ Apply', disabled: false })
  })

  it('affiche un texte de repli quand l\'annonce n\'a aucune place (au lieu d\'une section vide)', () => {
    const payload = renderPublicMessage(view({}, []), emojis)
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description).toContain('**Looking for:**')
    expect(embed.description.length).toBeGreaterThan(0)
    expect(embed.description).toContain('No spots configured yet')
  })
})

describe('dashboard', () => {
  it('liste les candidats sous leur place avec un select d\'acceptation', () => {
    const payload = renderDashboardMessage(
      view({}, [{
        applications: [
          { id: 'a1', applicantTag: 'PugA', ignRealm: 'PugA-Hyjal', itemLevel: 620, logsUrl: 'https://l/1', comment: 'Dispo tôt' },
          { id: 'a2', applicantTag: 'PugB', ignRealm: 'PugB-Archimonde', itemLevel: 626, logsUrl: 'https://l/2', comment: null },
        ],
      }] as never),
      emojis,
    )
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description).toContain('PugA-Hyjal')
    expect(embed.description).toContain('iLvl: 626')
    const select = (payload.components[0] as { components: { custom_id: string; options: unknown[] }[] }).components[0]!
    expect(select.custom_id).toBe('pug:1:dash:accept:s0')
    expect(select.options).toHaveLength(2)
  })

  it('n\'affiche pas de select pour une place déjà pourvue', () => {
    const payload = renderDashboardMessage(view({}, [{ status: 'FILLED' }]), emojis)
    expect(payload.components.filter((c) => (c as { components: { type: number }[] }).components[0]!.type === 3)).toHaveLength(0)
  })

  it('tronque au-delà de 25 candidats en annonçant le nombre masqué', () => {
    const applications = Array.from({ length: 30 }, (_, i) => ({
      id: `a${i}`, applicantTag: `P${i}`, ignRealm: `P${i}-R`, itemLevel: 600 + i,
      logsUrl: 'https://l', comment: null,
    }))
    const payload = renderDashboardMessage(view({}, [{ applications }] as never), emojis)
    const embed = payload.embeds[0] as { description: string }
    const select = (payload.components[0] as { components: { options: unknown[] }[] }).components[0]!
    expect(select.options).toHaveLength(25)
    expect(embed.description).toContain('5 more')
  })

  it('affiche un message d\'attente quand personne n\'a postulé', () => {
    const payload = renderDashboardMessage(view({}, [{}]), emojis)
    expect((payload.embeds[0] as { description: string }).description).toContain('No applications yet')
  })

  it('affiche un texte de repli quand l\'annonce n\'a aucune place, sans description vide', () => {
    const payload = renderDashboardMessage(view({}, []), emojis)
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description.length).toBeGreaterThan(0)
    expect(embed.description).toContain('No spots configured yet')
  })

  it('C1 — au plus 5 action rows pour 8 places ouvertes ayant chacune des candidatures (limite Discord)', () => {
    const slots = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      applications: [{ id: `a${i}`, applicantTag: `P${i}`, ignRealm: `P${i}-Realm`, itemLevel: 620, logsUrl: 'https://l', comment: null }],
    }))
    const payload = renderDashboardMessage(view({}, slots as never), emojis)
    expect(payload.components.length).toBeLessThanOrEqual(5)
    const closeButton = payload.components
      .flatMap((c) => (c as { components: { custom_id: string }[] }).components)
      .find((c) => c.custom_id === 'pug:1:dash:close:e1')
    expect(closeButton).toBeDefined()
    // Les places au-delà du plafond restent signalées dans le texte, pas silencieusement amputées.
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description).toMatch(/not shown|not actionable/)
  })

  it('C1 — description bornée à 4096 caractères pour 3 places à 25 candidats chacune', () => {
    const makeApplications = (prefix: string) => Array.from({ length: 25 }, (_, i) => ({
      id: `${prefix}-a${i}`, applicantTag: `P${i}`, ignRealm: `${prefix}-Player${i}-Realm`,
      itemLevel: 600 + i, logsUrl: 'https://warcraftlogs.com/reports/abcdefgh1234', comment: 'Available all week, flexible on role',
    }))
    const slots = [
      { id: 's0', applications: makeApplications('s0') },
      { id: 's1', applications: makeApplications('s1') },
      { id: 's2', applications: makeApplications('s2') },
    ]
    const payload = renderDashboardMessage(view({}, slots as never), emojis)
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description.length).toBeLessThanOrEqual(4096)
    const closeButton = payload.components
      .flatMap((c) => (c as { components: { custom_id: string }[] }).components)
      .find((c) => c.custom_id === 'pug:1:dash:close:e1')
    expect(closeButton).toBeDefined()
  })
})

describe('I6 — échappement markdown dans le dashboard', () => {
  it('escapeMarkdown échappe les caractères spéciaux markdown', () => {
    expect(escapeMarkdown('a`b*c_d[e]f\\g|h')).toBe('a\\`b\\*c\\_d\\[e\\]f\\\\g\\|h')
  })

  it('un commentaire contenant un lien markdown s\'affiche littéralement, pas comme un second lien', () => {
    const payload = renderDashboardMessage(
      view({}, [{
        applications: [{
          id: 'a1', applicantTag: 'Pug', ignRealm: 'Pug-Hyjal', itemLevel: 620,
          logsUrl: 'https://warcraftlogs.com/x', comment: '[clique](https://evil.example)',
        }],
      }] as never),
      emojis,
    )
    const embed = payload.embeds[0] as { description: string }
    // Les crochets sont échappés, ce qui empêche `[clique](https://evil.example)`
    // de former un second lien markdown ; les parenthèses seules (hors
    // crochets) ne déclenchent aucune syntaxe de lien.
    expect(embed.description).toContain('\\[clique\\](https://evil.example)')
  })

  it('une URL de logs contenant une parenthèse fermante ne referme pas le lien markdown prématurément', () => {
    const payload = renderDashboardMessage(
      view({}, [{
        applications: [{
          id: 'a1', applicantTag: 'Pug', ignRealm: 'Pug-Hyjal', itemLevel: 620,
          logsUrl: 'https://warcraftlogs.com/x)[cliquez ici](https://phishing.example', comment: null,
        }],
      }] as never),
      emojis,
    )
    const embed = payload.embeds[0] as { description: string }
    const line = embed.description.split('\n').find((l) => l.includes('[Logs]'))!
    // Le `)` d'origine dans l'URL malveillante a été encodé en `%29` : il ne
    // reste qu'un seul `)` non échappé dans la ligne, celui du template
    // `[Logs](...)` lui-même. Sans second `)` disponible, `[cliquez ici](...)`
    // ne peut jamais se refermer pour former un second lien cliquable.
    expect(line.match(/\)/g)?.length).toBe(1)
    expect(line).toContain('%29')
  })
})
