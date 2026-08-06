import { defineConfig, env } from 'prisma/config'

type Env = {
  DATABASE_URL: string
}

// Prisma 7 ne lit plus l'URL de connexion depuis `datasource.url` du schéma :
// la CLI (migrate, studio, ...) la lit désormais depuis ce fichier de config.
// Le client applicatif (src/db/client.ts, tests/helpers/db.ts) reste, lui,
// configuré indépendamment via un driver adapter.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
})
