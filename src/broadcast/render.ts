// Rendu des messages : fonctions pures état -> payload, sans dépendance à
// discord.js (frontière surveillée par tests/architecture.test.ts). On produit
// directement les structures JSON de l'API Discord (action row, bouton, select).

import type { EventView } from '../domain/events.js'
import type { MessagePayload } from './gateway.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { findSpec } from '../config/wow.js'

export const MAX_SELECT_OPTIONS = 25
const CLOSED: Record<string, string> = { COMPLETED: '[COMPLETED]', EXPIRED: '[EXPIRED]', CANCELLED: '[CANCELLED]' }
const DIFFICULTY_LABEL: Record<string, string> = { NORMAL: 'Normal', HEROIC: 'Heroic', MYTHIC: 'Mythic' }

export function buildCustomId(domain: string, action: string, id: string): string {
  return `pug:1:${domain}:${action}:${id}`
}

function specLabel(className: string, specName: string): string {
  return findSpec(className, specName)?.label ?? specName
}

function difficultyLabel(difficulty: string): string {
  return DIFFICULTY_LABEL[difficulty] ?? difficulty
}

function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`
}

export function renderPublicMessage(view: EventView, emojis: EmojiMap): MessagePayload {
  const { event, slots } = view
  const closed = CLOSED[event.status]
  const title = `${closed ? `${closed} ` : ''}🚨 LFG - ${event.raidName} (${difficultyLabel(event.difficulty)})`

  // Agrégation par (classe, spé, statut) : le RL saisit une ligne par place,
  // le lecteur veut une ligne par besoin. Le nombre n'est affiché que si la
  // combinaison classe/spé compte plus d'une place au total (open + filled
  // confondus) : une place unique reste "(Open)", tandis qu'un besoin de 3
  // places dont 1 déjà pourvue s'affiche "(2 Open)" / "(1 Filled)".
  const totals = new Map<string, number>()
  for (const slot of slots) {
    const specKey = `${slot.className}|${slot.specName}`
    totals.set(specKey, (totals.get(specKey) ?? 0) + 1)
  }

  const groups = new Map<string, { className: string; specName: string; filled: boolean; count: number }>()
  for (const slot of slots) {
    const filled = slot.status === 'FILLED'
    const key = `${slot.className}|${slot.specName}|${filled}`
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { className: slot.className, specName: slot.specName, filled, count: 1 })
  }

  const lines = [...groups.values()].map((g) => {
    const label = `${classEmoji(emojis, g.className)} ${specLabel(g.className, g.specName)}`
    const total = totals.get(`${g.className}|${g.specName}`) ?? g.count
    const state = total > 1 ? `(${g.count} ${g.filled ? 'Filled' : 'Open'})` : `(${g.filled ? 'Filled' : 'Open'})`
    return `${g.filled ? '✅' : '🔸'} ${label} ${state}`
  })

  return {
    embeds: [{
      title,
      description: [
        `🕒 ${discordTimestamp(event.scheduledAt)}`,
        `👤 Contact: ${event.authorContact}`,
        '',
        '**Looking for:**',
        ...lines,
      ].join('\n'),
      color: 0x5865f2,
      footer: { text: 'PugStone LFG network' },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 1, label: '⚔️ Apply',
        custom_id: buildCustomId('app', 'open', event.id),
        disabled: event.status !== 'PUBLISHED',
      }],
    }],
  }
}

export function renderDashboardMessage(view: EventView, emojis: EmojiMap): MessagePayload {
  const { event, slots } = view
  const sections: string[] = []
  const components: unknown[] = []

  for (const slot of slots) {
    const label = `${classEmoji(emojis, slot.className)} ${specLabel(slot.className, slot.specName)}`
    if (slot.status === 'FILLED') {
      sections.push(`✅ **${label}** — filled`)
      continue
    }
    const shown = slot.applications.slice(0, MAX_SELECT_OPTIONS)
    const hidden = slot.applications.length - shown.length
    sections.push(
      `🔹 **${label}** (open)`,
      ...(shown.length === 0
        ? ['   _No applications yet_']
        : shown.map((a) => `   \`${a.ignRealm}\` | iLvl: ${a.itemLevel} | [Logs](${a.logsUrl})${a.comment ? ` | "${a.comment}"` : ''}`)),
      ...(hidden > 0 ? [`   _…and ${hidden} more not shown_`] : []),
    )
    if (shown.length > 0) {
      components.push({
        type: 1,
        components: [{
          type: 3,
          custom_id: buildCustomId('dash', 'accept', slot.id),
          placeholder: `Accept for ${specLabel(slot.className, slot.specName)}`,
          options: shown.map((a) => ({
            label: `${a.ignRealm} — iLvl ${a.itemLevel}`.slice(0, 100),
            value: a.id,
            description: (a.comment ?? '').slice(0, 100) || undefined,
          })),
        }],
      })
    }
  }

  components.push({
    type: 1,
    components: [{
      type: 2, style: 4, label: 'Close listing',
      custom_id: buildCustomId('dash', 'close', event.id),
      disabled: event.status !== 'PUBLISHED',
    }],
  })

  return {
    embeds: [{
      title: `📋 ${event.raidName} (${difficultyLabel(event.difficulty)}) — ${discordTimestamp(event.scheduledAt)}`,
      description: sections.join('\n'),
      color: 0x2b2d31,
    }],
    components,
  }
}
