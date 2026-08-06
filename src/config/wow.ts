export type WowRoleName = 'TANK' | 'HEALER' | 'DPS'

export interface WowSpec {
  name: string
  label: string
  role: WowRoleName
}

export interface WowClass {
  name: string
  label: string
  color: number
  specs: WowSpec[]
}

// Couleurs de classe officielles de Blizzard, valeurs classiques (utilisées
// telles quelles depuis Wrath of the Cataclysm jusqu'aux couleurs actuelles
// de World of Warcraft), reprises pour les embeds Discord.
export const WOW_CLASSES: readonly WowClass[] = [
  {
    name: 'DEATH_KNIGHT', label: 'Death Knight', color: 0xc41f3b,
    specs: [
      { name: 'BLOOD', label: 'Blood', role: 'TANK' },
      { name: 'FROST', label: 'Frost', role: 'DPS' },
      { name: 'UNHOLY', label: 'Unholy', role: 'DPS' },
    ],
  },
  {
    name: 'DEMON_HUNTER', label: 'Demon Hunter', color: 0xa330c9,
    specs: [
      { name: 'HAVOC', label: 'Havoc', role: 'DPS' },
      { name: 'VENGEANCE', label: 'Vengeance', role: 'TANK' },
    ],
  },
  {
    name: 'DRUID', label: 'Druid', color: 0xff7d0a,
    specs: [
      { name: 'BALANCE', label: 'Balance', role: 'DPS' },
      { name: 'FERAL', label: 'Feral', role: 'DPS' },
      { name: 'GUARDIAN', label: 'Guardian', role: 'TANK' },
      { name: 'RESTORATION', label: 'Restoration', role: 'HEALER' },
    ],
  },
  {
    name: 'EVOKER', label: 'Evoker', color: 0x33937f,
    specs: [
      { name: 'DEVASTATION', label: 'Devastation', role: 'DPS' },
      { name: 'PRESERVATION', label: 'Preservation', role: 'HEALER' },
      { name: 'AUGMENTATION', label: 'Augmentation', role: 'DPS' },
    ],
  },
  {
    name: 'HUNTER', label: 'Hunter', color: 0xabd473,
    specs: [
      { name: 'BEAST_MASTERY', label: 'Beast Mastery', role: 'DPS' },
      { name: 'MARKSMANSHIP', label: 'Marksmanship', role: 'DPS' },
      { name: 'SURVIVAL', label: 'Survival', role: 'DPS' },
    ],
  },
  {
    name: 'MAGE', label: 'Mage', color: 0x3fc7eb,
    specs: [
      { name: 'ARCANE', label: 'Arcane', role: 'DPS' },
      { name: 'FIRE', label: 'Fire', role: 'DPS' },
      { name: 'FROST', label: 'Frost', role: 'DPS' },
    ],
  },
  {
    name: 'MONK', label: 'Monk', color: 0x00ff96,
    specs: [
      { name: 'BREWMASTER', label: 'Brewmaster', role: 'TANK' },
      { name: 'MISTWEAVER', label: 'Mistweaver', role: 'HEALER' },
      { name: 'WINDWALKER', label: 'Windwalker', role: 'DPS' },
    ],
  },
  {
    name: 'PALADIN', label: 'Paladin', color: 0xf58cba,
    specs: [
      { name: 'HOLY', label: 'Holy', role: 'HEALER' },
      { name: 'PROTECTION', label: 'Protection', role: 'TANK' },
      { name: 'RETRIBUTION', label: 'Retribution', role: 'DPS' },
    ],
  },
  {
    name: 'PRIEST', label: 'Priest', color: 0xffffff,
    specs: [
      { name: 'DISCIPLINE', label: 'Discipline', role: 'HEALER' },
      { name: 'HOLY', label: 'Holy', role: 'HEALER' },
      { name: 'SHADOW', label: 'Shadow', role: 'DPS' },
    ],
  },
  {
    name: 'ROGUE', label: 'Rogue', color: 0xfff569,
    specs: [
      { name: 'ASSASSINATION', label: 'Assassination', role: 'DPS' },
      { name: 'OUTLAW', label: 'Outlaw', role: 'DPS' },
      { name: 'SUBTLETY', label: 'Subtlety', role: 'DPS' },
    ],
  },
  {
    name: 'SHAMAN', label: 'Shaman', color: 0x0070de,
    specs: [
      { name: 'ELEMENTAL', label: 'Elemental', role: 'DPS' },
      { name: 'ENHANCEMENT', label: 'Enhancement', role: 'DPS' },
      { name: 'RESTORATION', label: 'Restoration', role: 'HEALER' },
    ],
  },
  {
    name: 'WARLOCK', label: 'Warlock', color: 0x8787ed,
    specs: [
      { name: 'AFFLICTION', label: 'Affliction', role: 'DPS' },
      { name: 'DEMONOLOGY', label: 'Demonology', role: 'DPS' },
      { name: 'DESTRUCTION', label: 'Destruction', role: 'DPS' },
    ],
  },
  {
    name: 'WARRIOR', label: 'Warrior', color: 0xc79c6e,
    specs: [
      { name: 'ARMS', label: 'Arms', role: 'DPS' },
      { name: 'FURY', label: 'Fury', role: 'DPS' },
      { name: 'PROTECTION', label: 'Protection', role: 'TANK' },
    ],
  },
] as const

export function findClass(name: string): WowClass | undefined {
  return WOW_CLASSES.find((c) => c.name === name.toUpperCase())
}

export function findSpec(className: string, specName: string): WowSpec | undefined {
  return findClass(className)?.specs.find((s) => s.name === specName.toUpperCase())
}
