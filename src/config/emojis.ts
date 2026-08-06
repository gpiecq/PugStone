import type { WowRoleName } from './wow.js'

export type EmojiMap = Record<string, string>

/** Un emoji mal configuré ne doit jamais empêcher le bot de démarrer. */
export function loadEmojiMap(raw: unknown): EmojiMap {
  if (typeof raw !== 'object' || raw === null) return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

export function classEmoji(map: EmojiMap, className: string): string {
  return map[className.toUpperCase()] ?? '•'
}

export function roleEmoji(role: WowRoleName): string {
  return { TANK: '🛡️', HEALER: '💚', DPS: '⚔️' }[role]
}
