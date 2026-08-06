// Rendu des messages : fonctions pures état -> payload, sans dépendance à
// discord.js (frontière surveillée par tests/architecture.test.ts). On produit
// directement les structures JSON de l'API Discord (action row, bouton, select).

import type { EventView } from '../domain/events.js'
import type { MessagePayload } from './gateway.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { findSpec } from '../config/wow.js'

export const MAX_SELECT_OPTIONS = 25
// Discord plafonne un message à 5 action rows. On réserve toujours la
// dernière au bouton « Close listing » (jamais amputé, quel que soit le
// nombre de places), ce qui laisse au plus 4 selects d'acceptation pilotables
// depuis ce dashboard — un roster de 5 places candidatées ou plus est le cas
// nominal (revue finale, constat C1), pas un cas limite.
export const MAX_DASHBOARD_SELECT_ROWS = 4
// `embed.description` est plafonné à 4096 caractères côté API Discord :
// dépasser cette taille (ex. plusieurs places à 25 candidats chacune) fait
// rejeter tout le message (50035), pas seulement la partie en trop.
export const MAX_EMBED_DESCRIPTION_LENGTH = 4096

const CLOSED: Record<string, string> = { COMPLETED: '[COMPLETED]', EXPIRED: '[EXPIRED]', CANCELLED: '[CANCELLED]' }
const DIFFICULTY_LABEL: Record<string, string> = { NORMAL: 'Normal', HEROIC: 'Heroic', MYTHIC: 'Mythic' }
const NO_SLOTS_PLACEHOLDER = '_No spots configured yet._'
const NO_APPLICATIONS_LINE = '   _No applications yet_'

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

/**
 * Échappe les caractères markdown Discord dans un texte saisi par un
 * candidat inconnu (pseudo, commentaire) avant insertion dans le dashboard
 * privé du Raid Leader. Sans ça, un commentaire du type `[cliquez ici](url)`
 * devient un lien cliquable, et un pseudo contenant un backtick referme
 * prématurément le bloc de code qui l'entoure (revue finale, constat I6).
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]|]/g, '\\$&')
}

/**
 * `new URL().toString()` n'encode ni `)` ni `\`, qui referment respectivement
 * un lien markdown (`[texte](url)`) et son échappement. Un candidat peut donc
 * soumettre une URL de logs valide de la forme
 * `https://warcraftlogs.com/x)[cliquez ici](https://phishing.example` pour
 * faire naître un second lien arbitraire, cliquable, dans le dashboard du RL.
 */
function safeMarkdownLink(url: string): string {
  return url.replace(/\\/g, '%5C').replace(/\)/g, '%29')
}

/**
 * Garantit que `embed.description` respecte toujours la limite Discord de
 * 4096 caractères, quel que soit le nombre de places et de candidats
 * (revue finale, constat C1). La troncature signale explicitement qu'elle a
 * eu lieu plutôt que de couper silencieusement le contenu.
 */
function boundDescription(sections: string[]): string {
  const full = sections.length > 0 ? sections.join('\n') : NO_SLOTS_PLACEHOLDER
  if (full.length <= MAX_EMBED_DESCRIPTION_LENGTH) return full
  const suffix = '\n\n_…truncated: message length limit reached, some content is hidden._'
  const budget = Math.max(0, MAX_EMBED_DESCRIPTION_LENGTH - suffix.length)
  return `${full.slice(0, budget)}${suffix}`
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
        ...(lines.length > 0 ? lines : [NO_SLOTS_PLACEHOLDER]),
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
  let hiddenSlots = 0

  for (const slot of slots) {
    const label = `${classEmoji(emojis, slot.className)} ${specLabel(slot.className, slot.specName)}`
    if (slot.status === 'FILLED') {
      sections.push(`✅ **${label}** — filled`)
      continue
    }

    const shown = slot.applications.slice(0, MAX_SELECT_OPTIONS)
    const hiddenApplications = slot.applications.length - shown.length

    if (shown.length > 0 && components.length >= MAX_DASHBOARD_SELECT_ROWS) {
      // Le dashboard est déjà au plafond de 4 selects (la 5e action row est
      // réservée au bouton Close listing) : cette place reste listée pour
      // information, mais n'est plus pilotable depuis ce message.
      hiddenSlots += 1
      sections.push(`🔹 **${label}** (open, ${shown.length} pending) — _not actionable here, dashboard is at capacity_`)
      continue
    }

    sections.push(
      `🔹 **${label}** (open)`,
      ...(shown.length === 0
        ? [NO_APPLICATIONS_LINE]
        : shown.map((a) =>
            `   \`${escapeMarkdown(a.ignRealm)}\` | iLvl: ${a.itemLevel} | [Logs](${safeMarkdownLink(a.logsUrl)})`
            + `${a.comment ? ` | "${escapeMarkdown(a.comment)}"` : ''}`,
          )),
      ...(hiddenApplications > 0 ? [`   _…and ${hiddenApplications} more not shown_`] : []),
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

  if (hiddenSlots > 0) {
    sections.push(`_…and ${hiddenSlots} more spot(s) with pending applications not shown (dashboard capacity reached)_`)
  }

  // Toujours ajoutée en dernier, hors du plafond de selects ci-dessus : ce
  // bouton ne doit jamais être amputé silencieusement, quel que soit le
  // nombre de places.
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
      description: boundDescription(sections),
      color: 0x2b2d31,
    }],
    components,
  }
}
