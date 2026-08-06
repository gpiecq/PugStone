import { z } from 'zod'

// Exporté séparément pour src/logger.ts : le logger doit pouvoir déterminer
// son niveau sans dépendre de la validation complète de env() (qui exige
// DISCORD_TOKEN, DISCORD_APP_ID, etc.), sans quoi importer le logger dans un
// contexte de test qui ne fournit pas ces variables ferait échouer l'import.
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  OWNER_DISCORD_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: logLevelSchema.default('info'),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown>): Env {
  const result = schema.safeParse(source)
  if (!result.success) {
    // Le message doit nommer les variables fautives : c'est la seule information
    // dont dispose l'exploitant quand le conteneur refuse de démarrer.
    const details = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ')
    throw new Error(`Configuration invalide — ${details}`)
  }
  return result.data
}

let cached: Env | undefined
export function env(): Env {
  cached ??= loadEnv(process.env)
  return cached
}
