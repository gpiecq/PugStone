import { describe, it, expect } from 'vitest'
import { WOW_CLASSES, findClass, findSpec } from '../../src/config/wow.js'
import { loadEmojiMap, classEmoji } from '../../src/config/emojis.js'

describe('données WoW', () => {
  it('déclare les 13 classes', () => {
    expect(WOW_CLASSES).toHaveLength(13)
  })

  it('associe chaque spé à un rôle et n\'expose aucun doublon de nom', () => {
    for (const cls of WOW_CLASSES) {
      const names = cls.specs.map((s) => s.name)
      expect(new Set(names).size).toBe(names.length)
      for (const spec of cls.specs) {
        expect(['TANK', 'HEALER', 'DPS']).toContain(spec.role)
      }
    }
  })

  it('retrouve une spé par classe et par nom', () => {
    expect(findSpec('MAGE', 'ARCANE')?.role).toBe('DPS')
    expect(findSpec('PALADIN', 'PROTECTION')?.role).toBe('TANK')
    expect(findSpec('MAGE', 'INEXISTANT')).toBeUndefined()
    expect(findClass('inconnue')).toBeUndefined()
  })
})

describe('emojis', () => {
  it('rend l\'emoji configuré', () => {
    const map = loadEmojiMap({ MAGE: '<:mage:111>' })
    expect(classEmoji(map, 'MAGE')).toBe('<:mage:111>')
  })

  it('se rabat sur un symbole neutre si la classe n\'est pas configurée', () => {
    expect(classEmoji(loadEmojiMap({}), 'MAGE')).toBe('•')
  })

  it('ignore les entrées non textuelles au lieu de planter au démarrage', () => {
    expect(loadEmojiMap({ MAGE: 42, DRUID: '<:druid:2>' })).toEqual({ DRUID: '<:druid:2>' })
  })
})
