import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    maxWorkers: 1,
    testTimeout: 15_000,
    // Valeurs fictives pour satisfaire env() (src/config/env.ts) dès que
    // tests/index.test.ts importe src/index.ts (Tâche 17) : ce module
    // importe `prisma` depuis src/db/client.ts, qui construit le driver
    // adapter — et donc appelle env() — au chargement du module, même si
    // aucune commande Discord n'est réellement exécutée pendant les tests.
    // La connexion à la base des TESTS reste entièrement portée par
    // TEST_DATABASE_URL (tests/helpers/db.ts), qui n'est pas ici : elle doit
    // continuer à être fournie explicitement (voir README).
    env: {
      DISCORD_TOKEN: 'test-token',
      DISCORD_APP_ID: 'test-app-id',
      OWNER_DISCORD_ID: 'test-owner-id',
      DATABASE_URL: 'postgresql://pugstone:pugstone@localhost:5433/pugstone',
    },
  },
})
