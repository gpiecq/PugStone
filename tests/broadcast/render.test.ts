import { describe, it, expect } from 'vitest'
import { renderPublicMessage, renderDashboardMessage } from '../../src/broadcast/render.js'
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
})
