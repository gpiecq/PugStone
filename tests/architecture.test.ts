import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

describe('frontière du domaine', () => {
  it("n'importe discord.js ni dans le domaine ni dans le rendu", () => {
    // src/broadcast/render.ts n'existe pas encore (Tâche 8) : un chemin manquant
    // est retiré de la liste plutôt que de faire planter readFileSync, sans quoi
    // ce test échouerait aujourd'hui pour une raison étrangère à son objet. On
    // filtre explicitement via existsSync (et non un try/catch qui avalerait
    // aussi de vraies erreurs de lecture) pour que le jour où le fichier
    // apparaît, il rejoigne automatiquement les fichiers vérifiés ci-dessous.
    const candidates = [...filesUnder('src/domain'), 'src/broadcast/render.ts']
    const files = candidates.filter((f) => existsSync(f))
    const offenders = files.filter((f) => /from ['"]discord\.js/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
