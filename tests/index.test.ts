import { describe, it, expect, vi, beforeAll } from 'vitest'

interface Loop { stop: () => void }

// src/index.ts importe `prisma` (valeur, pas type) depuis src/db/client.ts,
// qui construit le driver adapter — donc appelle env() — au chargement du
// module, même si main() ne tourne jamais pendant les tests. C'est le seul
// fichier de la suite qui a besoin de ces variables : on les pose avec
// vi.stubEnv juste pour la durée de l'import dynamique, puis on restaure
// immédiatement avec vi.unstubAllEnvs, pour ne pas affaiblir le filet de
// sécurité de env() (Tâche 1) sur le reste de la suite (revue Tâche 17 —
// un `test.env` global dans vitest.config.ts masquerait silencieusement
// n'importe quel futur test vérifiant qu'env() échoue sur une variable
// manquante ou malformée). DATABASE_URL est une chaîne délibérément
// inutilisable : ce module ne se connecte jamais réellement à une base
// pendant les tests, seule sa forme syntaxique compte pour satisfaire le
// schéma zod.
let startLoop: (name: string, intervalMs: number, task: () => Promise<unknown>) => Loop

beforeAll(async () => {
  vi.stubEnv('DISCORD_TOKEN', 'unused')
  vi.stubEnv('DISCORD_APP_ID', 'unused')
  vi.stubEnv('OWNER_DISCORD_ID', 'unused')
  vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@localhost:1/unused')
  ;({ startLoop } = await import('../src/index.js'))
  vi.unstubAllEnvs()
})

describe('startLoop', () => {
  it('poursuit ses itérations après une erreur', async () => {
    vi.useFakeTimers()
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)

    const loop = startLoop('test', 1000, task)
    await vi.advanceTimersByTimeAsync(3500)
    loop.stop()

    expect(task.mock.calls.length).toBeGreaterThanOrEqual(3)
    vi.useRealTimers()
  })

  it('cesse d\'appeler la tâche après stop()', async () => {
    vi.useFakeTimers()
    const task = vi.fn().mockResolvedValue(undefined)
    const loop = startLoop('test', 1000, task)
    await vi.advanceTimersByTimeAsync(1500)
    loop.stop()
    const callsAtStop = task.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(task.mock.calls.length).toBe(callsAtStop)
    vi.useRealTimers()
  })
})
