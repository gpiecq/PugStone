import { describe, it, expect } from 'vitest'
import { collectRecruiterRoleIds } from '../../src/commands/set-lfm-channel.js'

// Discord n'offre pas de sélecteur multi-rôles dans une commande : la
// façon idiomatique est d'exposer plusieurs options de rôle (`role`,
// `role2`, `role3`) et de fusionner leurs identifiants. On teste ici cette
// fonction pure, pas discord.js.
describe('collectRecruiterRoleIds', () => {
  it('conserve un seul rôle (non-régression)', () => {
    expect(collectRecruiterRoleIds(['r1'])).toEqual(['r1'])
  })

  it('enregistre deux rôles distincts', () => {
    expect(collectRecruiterRoleIds(['r1', 'r2'])).toEqual(['r1', 'r2'])
  })

  it('dédoublonne un même rôle choisi deux fois', () => {
    expect(collectRecruiterRoleIds(['r1', 'r1', 'r2'])).toEqual(['r1', 'r2'])
  })

  it('ignore les options facultatives non renseignées (undefined ou null)', () => {
    expect(collectRecruiterRoleIds(['r1', undefined, null])).toEqual(['r1'])
  })
})
