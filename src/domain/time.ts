import { DateTime } from 'luxon'
import { RaidTimeInvalid } from './errors.js'

const FORMAT_HELP =
  'Use `HH:MM` for the next occurrence, or `DD/MM HH:MM` for a specific date (24-hour clock).'

/**
 * Rend l'instant UTC correspondant à la saisie du Raid Leader.
 * Sans date, on prend la prochaine occurrence ; avec une date déjà passée,
 * on suppose l'année suivante plutôt que de refuser une saisie plausible.
 */
export function parseRaidTime(input: string, timezone: string, now: Date): Date {
  const reference = DateTime.fromJSDate(now, { zone: timezone })
  if (!reference.isValid) throw new RaidTimeInvalid(`Unknown timezone \`${timezone}\`.`)

  const trimmed = input.trim()
  const withDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/)
  const timeOnly = trimmed.match(/^(\d{1,2}):(\d{2})$/)

  // Luxon `set()` fait déborder silencieusement les composants hors bornes
  // (heure 25 -> 01:00 le lendemain, jour 32 -> mois suivant) au lieu de
  // rendre le résultat invalide : on revérifie donc chaque composant après
  // coup plutôt que de se fier au seul `isValid`.
  let candidate: DateTime
  if (withDate) {
    const day = Number(withDate[1])
    const month = Number(withDate[2])
    const hour = Number(withDate[3])
    const minute = Number(withDate[4])
    candidate = reference.set({ day, month, hour, minute, second: 0, millisecond: 0 })
    const overflowed = candidate.day !== day || candidate.month !== month
      || candidate.hour !== hour || candidate.minute !== minute
    if (!candidate.isValid || overflowed) {
      throw new RaidTimeInvalid(`\`${trimmed}\` is not a valid date. ${FORMAT_HELP}`)
    }
    if (candidate <= reference) candidate = candidate.plus({ years: 1 })
  } else if (timeOnly) {
    const hour = Number(timeOnly[1])
    const minute = Number(timeOnly[2])
    candidate = reference.set({ hour, minute, second: 0, millisecond: 0 })
    const overflowed = candidate.hour !== hour || candidate.minute !== minute
    if (!candidate.isValid || overflowed) {
      throw new RaidTimeInvalid(`\`${trimmed}\` is not a valid time. ${FORMAT_HELP}`)
    }
    if (candidate <= reference) candidate = candidate.plus({ days: 1 })
  } else {
    throw new RaidTimeInvalid(`Could not read \`${trimmed}\` as a time. ${FORMAT_HELP}`)
  }

  if (!candidate.isValid) throw new RaidTimeInvalid(`\`${trimmed}\` is not a valid date. ${FORMAT_HELP}`)
  return candidate.toUTC().toJSDate()
}
