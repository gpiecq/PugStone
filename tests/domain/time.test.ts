import { describe, it, expect } from 'vitest'
import { parseRaidTime } from '../../src/domain/time.js'
import { RaidTimeInvalid } from '../../src/domain/errors.js'

// 2026-08-06 à 18:00 heure de Paris (UTC+2 en été)
const now = new Date('2026-08-06T16:00:00Z')
const tz = 'Europe/Paris'

describe('parseRaidTime', () => {
  it('interprète HH:MM comme aujourd\'hui si l\'heure est à venir', () => {
    expect(parseRaidTime('20:30', tz, now).toISOString()).toBe('2026-08-06T18:30:00.000Z')
  })

  it('bascule sur le lendemain si l\'heure est déjà passée', () => {
    expect(parseRaidTime('09:00', tz, now).toISOString()).toBe('2026-08-07T07:00:00.000Z')
  })

  it('accepte une date explicite JJ/MM HH:MM', () => {
    expect(parseRaidTime('12/08 21:00', tz, now).toISOString()).toBe('2026-08-12T19:00:00.000Z')
  })

  it('reporte une date explicite déjà passée sur l\'année suivante', () => {
    expect(parseRaidTime('02/01 21:00', tz, now).toISOString()).toBe('2027-01-02T20:00:00.000Z')
  })

  it('respecte le fuseau du serveur émetteur', () => {
    expect(parseRaidTime('20:30', 'America/New_York', now).toISOString()).toBe('2026-08-07T00:30:00.000Z')
  })

  it('refuse un format inconnu en expliquant le format attendu', () => {
    expect(() => parseRaidTime('ce soir', tz, now)).toThrow(RaidTimeInvalid)
    expect(() => parseRaidTime('25:00', tz, now)).toThrow(RaidTimeInvalid)
  })

  it('refuse un fuseau invalide', () => {
    expect(() => parseRaidTime('20:30', 'Mars/Olympus', now)).toThrow(RaidTimeInvalid)
  })
})
