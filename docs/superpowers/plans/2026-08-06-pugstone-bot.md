# PugStone Bot — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le bot Discord PugStone de bout en bout : réseau LFG fermé sur invitation, annonces multi-rôles diffusées sur tous les serveurs partenaires, candidatures par modal, dashboard privé du Raid Leader, et synchronisation automatique des embeds à chaque place pourvue.

**Architecture:** Un process Node unique fait tourner trois boucles — client Discord, worker d'émission (outbox), planificateur. La logique métier n'importe jamais discord.js : elle passe par une interface `DiscordGateway` unique, ce qui la rend testable sans réseau. La cohérence multi-serveurs repose sur un compteur de version par annonce comparé au `syncedVersion` de chaque message publié ; la correction des attributions de places repose sur `SELECT … FOR UPDATE` en Postgres.

**Tech Stack:** Node 22 LTS, TypeScript (strict), discord.js v14, Prisma 6 + PostgreSQL 16, Vitest, Luxon (fuseaux horaires), pino (logs), p-limit (concurrence), zod (validation d'environnement), Docker Compose, GitHub Actions.

**Spec de référence:** `docs/superpowers/specs/2026-08-06-pugstone-lfg-bot-design.md`

## Global Constraints

- **Branche de travail :** `develop`. Aucun commit direct sur `main`.
- **Messages de commit :** conventional commits, en français, **sans aucun trailer `Co-Authored-By`** ni mention d'assistant. Règle utilisateur explicite.
- **Langue :** tous les textes destinés aux utilisateurs Discord sont **en anglais** (embeds, boutons, messages éphémères, DM, noms et descriptions de commandes). Code, commentaires et documentation en français.
- **TypeScript strict :** `strict: true`, `noUncheckedIndexedAccess: true`. Aucun `any` implicite, aucun `@ts-ignore`.
- **Aucun import de `discord.js` dans `src/domain/**` ni dans `src/broadcast/render.ts`.** Vérifié par un test dédié (Tâche 4).
- **Tests sur Postgres réel**, jamais sur une base en mémoire : le comportement testé dépend de `FOR UPDATE` et des contraintes d'unicité.
- **Base de test réinitialisée par TRUNCATE** entre chaque test, et non par rollback de transaction comme envisagé initialement dans la spec : les tests de concurrence exigent des connexions réellement distinctes, incompatibles avec une transaction englobante.
- **Format des `custom_id` :** `pug:1:<domaine>:<action>:<id>`, 100 caractères maximum, aucune donnée métier encodée.
- **Codes d'erreur Discord traités :** `50001`, `50013`, `10003` → cible inutilisable ; `10008` → message disparu ; tout le reste → transitoire.
- **Plafond de tentatives d'émission :** `MAX_ATTEMPTS = 8`.

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `src/config/env.ts` | Chargement et validation des variables d'environnement |
| `src/config/wow.ts` | Classes, spécialisations et rôles WoW (données statiques) |
| `src/config/emojis.ts` | Mapping classe → Application Emoji, avec repli |
| `src/db/client.ts` | Instance Prisma partagée |
| `src/domain/errors.ts` | Erreurs métier typées, communes à tous les services |
| `src/domain/network.ts` | Codes d'invitation, cycle de vie des serveurs partenaires |
| `src/domain/events.ts` | Brouillon, roster, publication, annulation, parsing de l'heure |
| `src/domain/applications.ts` | Validation, candidature, acceptation |
| `src/broadcast/render.ts` | `état → payload` (embed public et dashboard), fonctions pures |
| `src/broadcast/gateway.ts` | Interface `DiscordGateway` + classification des erreurs |
| `src/broadcast/outbox.ts` | Worker d'émission : sélection, envoi/édition, backoff |
| `src/bot/gateway.ts` | Implémentation de `DiscordGateway` au-dessus de discord.js |
| `src/bot/router.ts` | Construction et analyse des `custom_id`, aiguillage |
| `src/bot/client.ts` | Client Discord, intents, enregistrement des commandes |
| `src/commands/*.ts` | `/network`, `/set-lfg-channel`, `/recruit`, `/cancel` |
| `src/interactions/*.ts` | Handlers de boutons, selects et modals |
| `src/scheduler/expiration.ts` | Passage en `EXPIRED` des annonces échues |
| `src/scheduler/retention.ts` | Purge des données anciennes |
| `src/index.ts` | Démarrage et arrêt propre des trois boucles |
| `tests/helpers/db.ts` | Connexion de test, `resetDb()` |
| `tests/helpers/fake-gateway.ts` | `DiscordGateway` en mémoire, scriptable en échec |
| `tests/helpers/factories.ts` | Fabriques de données de test |

**Écart assumé par rapport à la spec :** la couche `repositories` mentionnée au §3 est abandonnée (YAGNI). Chaque service du domaine reçoit un client Prisma ou un client transactionnel en premier argument et écrit ses requêtes directement. L'indirection n'apporterait rien : Prisma est déjà l'abstraction d'accès aux données, et les tests tournent sur une vraie base.

---

### Task 1: Socle du projet

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml`, `src/config/env.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: rien
- Produces: `loadEnv(source: NodeJS.ProcessEnv): Env` et `type Env = { DISCORD_TOKEN: string; DISCORD_APP_ID: string; OWNER_DISCORD_ID: string; DATABASE_URL: string; LOG_LEVEL: 'debug'|'info'|'warn'|'error' }`, plus l'export paresseux `env`.

- [ ] **Step 1: Initialiser le projet Node**

```bash
npm init -y
npm pkg set type=module
npm i discord.js @prisma/client luxon pino p-limit zod
npm i -D typescript tsx vitest prisma @types/node @types/luxon
```

- [ ] **Step 2: Créer `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests", "prisma"]
}
```

- [ ] **Step 3: Créer `vitest.config.ts`**

Les tests partagent une base Postgres unique : ils doivent s'exécuter en série, sinon un `TRUNCATE` d'un fichier efface les données d'un autre.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 15_000,
  },
})
```

- [ ] **Step 4: Créer `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: pugstone
      POSTGRES_PASSWORD: pugstone
      POSTGRES_DB: pugstone
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U pugstone']
      interval: 5s
      retries: 10
volumes:
  pgdata:
```

- [ ] **Step 5: Écrire le test d'environnement défaillant**

Fichier `tests/config/env.test.ts` :

```ts
import { describe, it, expect } from 'vitest'
import { loadEnv } from '../../src/config/env.js'

const valid = {
  DISCORD_TOKEN: 'token',
  DISCORD_APP_ID: '123',
  OWNER_DISCORD_ID: '456',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
}

describe('loadEnv', () => {
  it('accepte une configuration complète et applique LOG_LEVEL=info par défaut', () => {
    expect(loadEnv(valid).LOG_LEVEL).toBe('info')
  })

  it('échoue en nommant la variable manquante', () => {
    const { DISCORD_TOKEN, ...incomplete } = valid
    expect(() => loadEnv(incomplete)).toThrow(/DISCORD_TOKEN/)
  })

  it('refuse un LOG_LEVEL inconnu', () => {
    expect(() => loadEnv({ ...valid, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/)
  })
})
```

- [ ] **Step 6: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/config/env.test.ts`
Expected: FAIL — le module `src/config/env.ts` n'existe pas.

- [ ] **Step 7: Implémenter `src/config/env.ts`**

```ts
import { z } from 'zod'

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  OWNER_DISCORD_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
```

- [ ] **Step 8: Vérifier que les tests passent**

Run: `npx vitest run tests/config/env.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Créer `.gitignore` et `.env.example`**

`.gitignore` :

```
node_modules/
dist/
.env
*.log
```

`.env.example` :

```
DISCORD_TOKEN=
DISCORD_APP_ID=
OWNER_DISCORD_ID=
DATABASE_URL=postgresql://pugstone:pugstone@localhost:5432/pugstone
TEST_DATABASE_URL=postgresql://pugstone:pugstone@localhost:5432/pugstone_test
LOG_LEVEL=info
```

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts docker-compose.yml .gitignore .env.example src/config/env.ts tests/config/env.test.ts
git commit -m "feat: socle du projet et validation de la configuration"
```

---

### Task 2: Schéma de données et harnais de test

**Files:**
- Create: `prisma/schema.prisma`, `src/db/client.ts`, `tests/helpers/db.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: `Env` (Tâche 1)
- Produces: `prisma` (instance `PrismaClient` partagée), tous les modèles et enums de la spec §4, `testDb()` et `resetDb()` pour les tests.

- [ ] **Step 1: Écrire `prisma/schema.prisma`**

Recopier intégralement le modèle du §4 de la spec, en ajoutant les relations et index nécessaires :

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum GuildStatus  { ACTIVE NEEDS_ATTENTION SUSPENDED }
enum Difficulty   { NORMAL HEROIC MYTHIC }
enum EventStatus  { DRAFT PUBLISHED COMPLETED EXPIRED CANCELLED }
enum SlotStatus   { OPEN FILLED }
enum AppStatus    { PENDING ACCEPTED DISCARDED }
enum WowRole      { TANK HEALER DPS }
enum MessageKind  { PUBLIC DASHBOARD }

model Guild {
  id               String      @id @default(cuid())
  discordGuildId   String      @unique
  lfgChannelId     String?
  recruiterRoleIds String[]
  timezone         String
  status           GuildStatus @default(ACTIVE)
  statusReason     String?
  joinedAt         DateTime    @default(now())
  inviteCode       InviteCode?
  events           Event[]
  @@index([status])
}

model InviteCode {
  code        String    @id
  createdBy   String
  usedByGuild String?   @unique
  guild       Guild?    @relation(fields: [usedByGuild], references: [id])
  usedAt      DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
}

model Event {
  id                 String       @id @default(cuid())
  originGuildId      String
  originGuild        Guild        @relation(fields: [originGuildId], references: [id], onDelete: Cascade)
  authorId           String
  authorContact      String       @default("")
  raidName           String
  difficulty         Difficulty
  scheduledAt        DateTime
  status             EventStatus  @default(DRAFT)
  publicVersion      Int          @default(0)
  dashboardVersion   Int          @default(0)
  dashboardChannelId String?
  dashboardMessageId String?
  createdAt          DateTime     @default(now())
  slots              Slot[]
  messages           EventMessage[]
  @@index([status, scheduledAt])
}

model Slot {
  id                    String      @id @default(cuid())
  eventId               String
  event                 Event       @relation(fields: [eventId], references: [id], onDelete: Cascade)
  className             String
  specName              String
  role                  WowRole
  status                SlotStatus  @default(OPEN)
  acceptedApplicationId String?     @unique
  position              Int
  applications          Application[]
  @@index([eventId])
}

model Application {
  id           String    @id @default(cuid())
  slotId       String
  slot         Slot      @relation(fields: [slotId], references: [id], onDelete: Cascade)
  applicantId  String
  applicantTag String
  ignRealm     String
  itemLevel    Int
  logsUrl      String
  comment      String?
  status       AppStatus @default(PENDING)
  createdAt    DateTime  @default(now())
  @@unique([slotId, applicantId])
  @@index([slotId, status])
}

model EventMessage {
  id            String      @id @default(cuid())
  eventId       String
  event         Event       @relation(fields: [eventId], references: [id], onDelete: Cascade)
  guildId       String
  channelId     String
  messageId     String?
  kind          MessageKind
  syncedVersion Int         @default(-1)
  disabled      Boolean     @default(false)
  attempts      Int         @default(0)
  nextAttemptAt DateTime    @default(now())
  lastError     String?
  @@unique([eventId, guildId, kind])
  @@index([disabled, nextAttemptAt])
}
```

- [ ] **Step 2: Démarrer Postgres, créer la base de test et générer la migration**

```bash
docker compose up -d postgres
npx prisma migrate dev --name init
psql postgresql://pugstone:pugstone@localhost:5432/postgres -c "CREATE DATABASE pugstone_test"
DATABASE_URL=postgresql://pugstone:pugstone@localhost:5432/pugstone_test npx prisma migrate deploy
```

- [ ] **Step 3: Créer `src/db/client.ts`**

```ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
```

`Db` accepte indifféremment le client global ou un client transactionnel : tous les services du domaine le prennent en premier argument, ce qui permet de les composer dans une même transaction.

- [ ] **Step 4: Créer `tests/helpers/db.ts`**

```ts
import { PrismaClient } from '@prisma/client'

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL doit pointer vers une base dédiée aux tests')

export const testDb = new PrismaClient({ datasources: { db: { url } } })

export async function resetDb(): Promise<void> {
  // TRUNCATE plutôt que rollback de transaction : les tests de concurrence
  // utilisent des connexions distinctes et ne peuvent pas partager une transaction.
  await testDb.$executeRawUnsafe(
    'TRUNCATE "EventMessage", "Application", "Slot", "Event", "InviteCode", "Guild" RESTART IDENTITY CASCADE',
  )
}
```

- [ ] **Step 5: Écrire le test des contraintes**

Fichier `tests/db/schema.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

async function seedSlot() {
  const guild = await testDb.guild.create({
    data: { discordGuildId: 'g1', timezone: 'Europe/Paris', recruiterRoleIds: [] },
  })
  const event = await testDb.event.create({
    data: {
      originGuildId: guild.id, authorId: 'u1', raidName: 'Nerub-ar',
      difficulty: 'HEROIC', scheduledAt: new Date('2026-09-01T19:00:00Z'),
    },
  })
  return testDb.slot.create({
    data: { eventId: event.id, className: 'MAGE', specName: 'ARCANE', role: 'DPS', position: 0 },
  })
}

describe('contraintes du schéma', () => {
  it('interdit deux candidatures du même joueur sur la même place', async () => {
    const slot = await seedSlot()
    const base = {
      slotId: slot.id, applicantId: 'p1', applicantTag: 'p1#0',
      ignRealm: 'Pug-Hyjal', itemLevel: 620, logsUrl: 'https://warcraftlogs.com/x',
    }
    await testDb.application.create({ data: base })
    await expect(testDb.application.create({ data: base })).rejects.toThrow()
  })

  it('interdit deux messages du même type pour la même annonce et le même serveur', async () => {
    const slot = await seedSlot()
    const row = { eventId: slot.eventId, guildId: 'g1', channelId: 'c1', kind: 'PUBLIC' as const }
    await testDb.eventMessage.create({ data: row })
    await expect(testDb.eventMessage.create({ data: row })).rejects.toThrow()
  })

  it('supprime en cascade les places et candidatures avec leur annonce', async () => {
    const slot = await seedSlot()
    await testDb.event.delete({ where: { id: slot.eventId } })
    expect(await testDb.slot.count()).toBe(0)
  })
})
```

- [ ] **Step 6: Lancer les tests**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS (3 tests). En cas d'échec sur `TEST_DATABASE_URL`, vérifier que la base `pugstone_test` existe et que les migrations y ont été appliquées.

- [ ] **Step 7: Commit**

```bash
git add prisma src/db tests/helpers/db.ts tests/db
git commit -m "feat: schema de donnees et harnais de test Postgres"
```

---

### Task 3: Données WoW et emojis

**Files:**
- Create: `src/config/wow.ts`, `src/config/emojis.ts`, `config/emojis.json`
- Test: `tests/config/wow.test.ts`

**Interfaces:**
- Consumes: rien
- Produces:
  - `type WowRoleName = 'TANK' | 'HEALER' | 'DPS'`
  - `interface WowSpec { name: string; label: string; role: WowRoleName }`
  - `interface WowClass { name: string; label: string; color: number; specs: WowSpec[] }`
  - `WOW_CLASSES: readonly WowClass[]`, `findClass(name)`, `findSpec(className, specName)`
  - `type EmojiMap = Record<string, string>`, `loadEmojiMap(raw: unknown): EmojiMap`, `classEmoji(map, className)`, `roleEmoji(role)`

- [ ] **Step 1: Écrire le test**

Fichier `tests/config/wow.test.ts` :

```ts
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
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/config/wow.test.ts`
Expected: FAIL — modules absents.

- [ ] **Step 3: Implémenter `src/config/wow.ts`**

Les 13 classes de World of Warcraft avec leurs spécialisations et le rôle de chacune. Extrait de la forme attendue, à compléter pour les 13 classes (Death Knight, Demon Hunter, Druid, Evoker, Hunter, Mage, Monk, Paladin, Priest, Rogue, Shaman, Warlock, Warrior) :

```ts
export type WowRoleName = 'TANK' | 'HEALER' | 'DPS'
export interface WowSpec { name: string; label: string; role: WowRoleName }
export interface WowClass { name: string; label: string; color: number; specs: WowSpec[] }

export const WOW_CLASSES: readonly WowClass[] = [
  {
    name: 'PALADIN', label: 'Paladin', color: 0xf58cba,
    specs: [
      { name: 'HOLY', label: 'Holy', role: 'HEALER' },
      { name: 'PROTECTION', label: 'Protection', role: 'TANK' },
      { name: 'RETRIBUTION', label: 'Retribution', role: 'DPS' },
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
  // … les 11 autres classes, même forme
] as const

export function findClass(name: string): WowClass | undefined {
  return WOW_CLASSES.find((c) => c.name === name.toUpperCase())
}

export function findSpec(className: string, specName: string): WowSpec | undefined {
  return findClass(className)?.specs.find((s) => s.name === specName.toUpperCase())
}
```

- [ ] **Step 4: Implémenter `src/config/emojis.ts` et `config/emojis.json`**

```ts
import type { WowRoleName } from './wow.js'

export type EmojiMap = Record<string, string>

/** Un emoji mal configuré ne doit jamais empêcher le bot de démarrer. */
export function loadEmojiMap(raw: unknown): EmojiMap {
  if (typeof raw !== 'object' || raw === null) return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

export function classEmoji(map: EmojiMap, className: string): string {
  return map[className.toUpperCase()] ?? '•'
}

export function roleEmoji(role: WowRoleName): string {
  return { TANK: '🛡️', HEALER: '💚', DPS: '⚔️' }[role]
}
```

`config/emojis.json` contient initialement `{}` : les Application Emojis seront téléversés sur l'application Discord puis leurs identifiants reportés ici, sans changement de code.

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npx vitest run tests/config/wow.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/config/wow.ts src/config/emojis.ts config/emojis.json tests/config/wow.test.ts
git commit -m "feat: donnees des classes WoW et mapping des emojis"
```

---

### Task 4: Frontière Discord — interface, faux client, classification des erreurs

**Files:**
- Create: `src/broadcast/gateway.ts`, `tests/helpers/fake-gateway.ts`
- Test: `tests/broadcast/gateway.test.ts`, `tests/architecture.test.ts`

**Interfaces:**
- Consumes: rien
- Produces:
  - `interface MessagePayload { content?: string; embeds: unknown[]; components: unknown[] }`
  - `interface DiscordGateway { sendMessage(channelId, payload): Promise<{ messageId: string }>; editMessage(channelId, messageId, payload): Promise<void>; sendDM(userId, payload): Promise<{ channelId: string; messageId: string }>; createPrivateThread(channelId, name, inviteUserId): Promise<{ channelId: string }> }`
  - `type FailureKind = 'TRANSIENT' | 'TARGET_UNUSABLE' | 'MESSAGE_GONE'`
  - `classifyDiscordError(error: unknown): FailureKind`
  - `FakeGateway` (tests) : `sent`, `edited`, `dms`, `failNext(error)`, `failAlways(error)`, `discordError(code)`

- [ ] **Step 1: Écrire le test de classification**

Fichier `tests/broadcast/gateway.test.ts` :

```ts
import { describe, it, expect } from 'vitest'
import { classifyDiscordError } from '../../src/broadcast/gateway.js'
import { discordError } from '../helpers/fake-gateway.js'

describe('classifyDiscordError', () => {
  it('traite les permissions et salons manquants comme une cible inutilisable', () => {
    for (const code of [50001, 50013, 10003]) {
      expect(classifyDiscordError(discordError(code))).toBe('TARGET_UNUSABLE')
    }
  })

  it('traite un message inconnu comme un message disparu', () => {
    expect(classifyDiscordError(discordError(10008))).toBe('MESSAGE_GONE')
  })

  it('traite tout le reste comme transitoire', () => {
    expect(classifyDiscordError(discordError(500))).toBe('TRANSIENT')
    expect(classifyDiscordError(new Error('socket hang up'))).toBe('TRANSIENT')
    expect(classifyDiscordError(undefined)).toBe('TRANSIENT')
  })
})
```

- [ ] **Step 2: Écrire le test d'architecture**

Ce test protège la contrainte globale la plus facile à violer par inadvertance : le domaine ne doit jamais importer discord.js.

Fichier `tests/architecture.test.ts` :

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

describe('frontière du domaine', () => {
  it('n\'importe discord.js ni dans le domaine ni dans le rendu', () => {
    const files = [...filesUnder('src/domain'), 'src/broadcast/render.ts']
    const offenders = files.filter((f) => /from ['"]discord\.js/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 3: Lancer les tests et vérifier l'échec**

Run: `npx vitest run tests/broadcast/gateway.test.ts tests/architecture.test.ts`
Expected: FAIL — modules absents (le test d'architecture échouera aussi tant que `src/domain` n'existe pas ; créer le dossier avec un `.gitkeep` si nécessaire).

- [ ] **Step 4: Implémenter `src/broadcast/gateway.ts`**

```ts
export interface MessagePayload {
  content?: string
  embeds: unknown[]
  components: unknown[]
}

export interface DiscordGateway {
  sendMessage(channelId: string, payload: MessagePayload): Promise<{ messageId: string }>
  editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<void>
  sendDM(userId: string, payload: MessagePayload): Promise<{ channelId: string; messageId: string }>
  createPrivateThread(channelId: string, name: string, inviteUserId: string): Promise<{ channelId: string }>
}

export type FailureKind = 'TRANSIENT' | 'TARGET_UNUSABLE' | 'MESSAGE_GONE'

const TARGET_UNUSABLE_CODES = new Set([50001, 50013, 10003])

/**
 * Une erreur inconnue est délibérément classée transitoire : réessayer huit fois
 * pour rien est sans conséquence, alors qu'abandonner à tort perd une publication.
 */
export function classifyDiscordError(error: unknown): FailureKind {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'number') return 'TRANSIENT'
  if (TARGET_UNUSABLE_CODES.has(code)) return 'TARGET_UNUSABLE'
  if (code === 10008) return 'MESSAGE_GONE'
  return 'TRANSIENT'
}
```

- [ ] **Step 5: Implémenter `tests/helpers/fake-gateway.ts`**

```ts
import type { DiscordGateway, MessagePayload } from '../../src/broadcast/gateway.js'

export function discordError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Discord error ${code}`), { code })
}

export class FakeGateway implements DiscordGateway {
  sent: { channelId: string; messageId: string; payload: MessagePayload }[] = []
  edited: { channelId: string; messageId: string; payload: MessagePayload }[] = []
  dms: { userId: string; payload: MessagePayload }[] = []
  threads: { channelId: string; name: string; inviteUserId: string }[] = []

  private queued: unknown[] = []
  private permanent: unknown

  /** Fait échouer les N prochains appels, dans l'ordre. */
  failNext(...errors: unknown[]): void { this.queued.push(...errors) }
  failAlways(error: unknown): void { this.permanent = error }

  private check(): void {
    const next = this.queued.shift() ?? this.permanent
    if (next) throw next
  }

  private nextId = 0
  private id(): string { return `m${++this.nextId}` }

  async sendMessage(channelId: string, payload: MessagePayload) {
    this.check()
    const messageId = this.id()
    this.sent.push({ channelId, messageId, payload })
    return { messageId }
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload) {
    this.check()
    this.edited.push({ channelId, messageId, payload })
  }

  async sendDM(userId: string, payload: MessagePayload) {
    this.check()
    this.dms.push({ userId, payload })
    return { channelId: `dm-${userId}`, messageId: this.id() }
  }

  async createPrivateThread(channelId: string, name: string, inviteUserId: string) {
    this.check()
    this.threads.push({ channelId, name, inviteUserId })
    return { channelId: `thread-${channelId}` }
  }
}
```

- [ ] **Step 6: Vérifier que les tests passent**

Run: `npx vitest run tests/broadcast/gateway.test.ts tests/architecture.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/broadcast/gateway.ts tests/helpers/fake-gateway.ts tests/broadcast/gateway.test.ts tests/architecture.test.ts
git commit -m "feat: interface DiscordGateway et classification des erreurs"
```

---

### Task 5: Erreurs métier et service réseau

**Files:**
- Create: `src/domain/errors.ts`, `src/domain/network.ts`
- Test: `tests/domain/network.test.ts`

**Interfaces:**
- Consumes: `Db` (Tâche 2)
- Produces:
  - `class DomainError extends Error { readonly userMessage: string }` et ses sous-classes `InviteCodeUnusable`, `NotAuthorized`, `EmptyRoster`, `NoActivePartners`, `RaidTimeInvalid`, `SlotAlreadyFilled`, `EventClosed`, `SlotNotFound`
  - `createInviteCode(db, ownerId): Promise<string>`
  - `revokeInviteCode(db, code): Promise<void>`
  - `redeemInviteCode(db, { code, discordGuildId, lfgChannelId, recruiterRoleIds, timezone }): Promise<Guild>`
  - `updateGuildConfig(db, { discordGuildId, lfgChannelId?, recruiterRoleIds?, timezone? }): Promise<Guild>`
  - `listActiveGuilds(db): Promise<Guild[]>`
  - `markGuildNeedsAttention(db, guildId, reason): Promise<void>`
  - `suspendGuild(db, discordGuildId): Promise<void>`

- [ ] **Step 1: Écrire le test**

Fichier `tests/domain/network.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import {
  createInviteCode, revokeInviteCode, redeemInviteCode,
  updateGuildConfig, listActiveGuilds, markGuildNeedsAttention, suspendGuild,
} from '../../src/domain/network.js'
import { InviteCodeUnusable } from '../../src/domain/errors.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const config = (code: string, guild = 'g1') => ({
  code, discordGuildId: guild, lfgChannelId: 'c1',
  recruiterRoleIds: ['r1'], timezone: 'Europe/Paris',
})

describe('admission au réseau', () => {
  it('consomme un code et crée le serveur partenaire', async () => {
    const code = await createInviteCode(testDb, 'owner')
    const guild = await redeemInviteCode(testDb, config(code))
    expect(guild.status).toBe('ACTIVE')
    expect(guild.lfgChannelId).toBe('c1')
    const used = await testDb.inviteCode.findUniqueOrThrow({ where: { code } })
    expect(used.usedByGuild).toBe(guild.id)
    expect(used.usedAt).not.toBeNull()
  })

  it('refuse un code déjà consommé', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await redeemInviteCode(testDb, config(code, 'g1'))
    await expect(redeemInviteCode(testDb, config(code, 'g2'))).rejects.toBeInstanceOf(InviteCodeUnusable)
  })

  it('refuse un code révoqué ou inexistant', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await revokeInviteCode(testDb, code)
    await expect(redeemInviteCode(testDb, config(code))).rejects.toBeInstanceOf(InviteCodeUnusable)
    await expect(redeemInviteCode(testDb, config('inconnu'))).rejects.toBeInstanceOf(InviteCodeUnusable)
  })

  it('ne consomme le code qu\'une seule fois même sous deux appels simultanés', async () => {
    const code = await createInviteCode(testDb, 'owner')
    const results = await Promise.allSettled([
      redeemInviteCode(testDb, config(code, 'gA')),
      redeemInviteCode(testDb, config(code, 'gB')),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await testDb.guild.count()).toBe(1)
  })

  it('permet de reconfigurer un serveur sans nouveau code', async () => {
    const code = await createInviteCode(testDb, 'owner')
    await redeemInviteCode(testDb, config(code))
    const updated = await updateGuildConfig(testDb, {
      discordGuildId: 'g1', lfgChannelId: 'c2', recruiterRoleIds: ['r2', 'r3'],
    })
    expect(updated.lfgChannelId).toBe('c2')
    expect(updated.recruiterRoleIds).toEqual(['r2', 'r3'])
    expect(updated.timezone).toBe('Europe/Paris')
  })
})

describe('cibles de diffusion', () => {
  it('ne retient que les serveurs actifs avec un salon configuré', async () => {
    const code1 = await createInviteCode(testDb, 'owner')
    const code2 = await createInviteCode(testDb, 'owner')
    const code3 = await createInviteCode(testDb, 'owner')
    const a = await redeemInviteCode(testDb, config(code1, 'gA'))
    await redeemInviteCode(testDb, config(code2, 'gB'))
    await redeemInviteCode(testDb, config(code3, 'gC'))
    await markGuildNeedsAttention(testDb, a.id, 'salon supprimé')
    await suspendGuild(testDb, 'gB')

    const active = await listActiveGuilds(testDb)
    expect(active.map((g) => g.discordGuildId)).toEqual(['gC'])
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/domain/network.test.ts`
Expected: FAIL — modules absents.

- [ ] **Step 3: Implémenter `src/domain/errors.ts`**

Chaque erreur métier porte le texte anglais montré à l'utilisateur : les handlers n'ont ainsi jamais à traduire un code d'erreur en phrase.

```ts
export class DomainError extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message)
    this.name = new.target.name
  }
}

export class InviteCodeUnusable extends DomainError {
  constructor() { super('code invalide, consommé ou révoqué', 'This invite code is invalid or has already been used.') }
}
export class NotAuthorized extends DomainError {
  constructor(what = 'this action') { super('action non autorisée', `You are not allowed to perform ${what}.`) }
}
export class EmptyRoster extends DomainError {
  constructor() { super('roster vide', 'Add at least one spot before publishing.') }
}
export class NoActivePartners extends DomainError {
  constructor() { super('aucun partenaire actif', 'No partner server is currently available to receive this listing.') }
}
export class RaidTimeInvalid extends DomainError {
  constructor(userMessage: string) { super('heure de raid invalide', userMessage) }
}
export class SlotAlreadyFilled extends DomainError {
  constructor() { super('place déjà pourvue', 'This spot has just been filled.') }
}
export class EventClosed extends DomainError {
  constructor() { super('annonce close', 'This listing is no longer accepting applications.') }
}
export class SlotNotFound extends DomainError {
  constructor() { super('place introuvable', 'This spot no longer exists.') }
}
```

- [ ] **Step 4: Implémenter `src/domain/network.ts`**

```ts
import { randomBytes } from 'node:crypto'
import type { Guild } from '@prisma/client'
import type { Db } from '../db/client.js'
import { InviteCodeUnusable } from './errors.js'

/** Base 32 sans caractères ambigus : un code se dicte à l'oral sans confusion. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateCode(): string {
  return [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('')
}

export async function createInviteCode(db: Db, ownerId: string): Promise<string> {
  const code = generateCode()
  await db.inviteCode.create({ data: { code, createdBy: ownerId } })
  return code
}

export async function revokeInviteCode(db: Db, code: string): Promise<void> {
  await db.inviteCode.updateMany({
    where: { code, usedByGuild: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export interface RedeemParams {
  code: string
  discordGuildId: string
  lfgChannelId: string
  recruiterRoleIds: string[]
  timezone: string
}

export async function redeemInviteCode(db: Db, params: RedeemParams): Promise<Guild> {
  return db.$transaction(async (tx) => {
    // Verrou de ligne : deux serveurs qui soumettent le même code au même instant
    // sont sérialisés ici, le second constate que usedByGuild n'est plus null.
    const rows = await tx.$queryRaw<{ code: string; usedByGuild: string | null; revokedAt: Date | null }[]>`
      SELECT code, "usedByGuild", "revokedAt" FROM "InviteCode" WHERE code = ${params.code} FOR UPDATE
    `
    const invite = rows[0]
    if (!invite || invite.usedByGuild || invite.revokedAt) throw new InviteCodeUnusable()

    const guild = await tx.guild.create({
      data: {
        discordGuildId: params.discordGuildId,
        lfgChannelId: params.lfgChannelId,
        recruiterRoleIds: params.recruiterRoleIds,
        timezone: params.timezone,
        status: 'ACTIVE',
      },
    })
    await tx.inviteCode.update({
      where: { code: params.code },
      data: { usedByGuild: guild.id, usedAt: new Date() },
    })
    return guild
  })
}

export interface UpdateGuildParams {
  discordGuildId: string
  lfgChannelId?: string
  recruiterRoleIds?: string[]
  timezone?: string
}

export async function updateGuildConfig(db: Db, params: UpdateGuildParams): Promise<Guild> {
  const { discordGuildId, ...changes } = params
  return db.guild.update({
    where: { discordGuildId },
    // Reconfigurer un serveur le remet dans le circuit : c'est la façon dont un
    // admin corrige un salon supprimé sans repasser par un code d'invitation.
    data: { ...changes, status: 'ACTIVE', statusReason: null },
  })
}

export function listActiveGuilds(db: Db): Promise<Guild[]> {
  return db.guild.findMany({
    where: { status: 'ACTIVE', lfgChannelId: { not: null } },
    orderBy: { joinedAt: 'asc' },
  })
}

export async function markGuildNeedsAttention(db: Db, guildId: string, reason: string): Promise<void> {
  await db.guild.update({
    where: { id: guildId },
    data: { status: 'NEEDS_ATTENTION', statusReason: reason },
  })
}

export async function suspendGuild(db: Db, discordGuildId: string): Promise<void> {
  await db.guild.updateMany({
    where: { discordGuildId },
    data: { status: 'SUSPENDED', statusReason: 'bot retiré du serveur' },
  })
  await db.eventMessage.updateMany({ where: { guildId: discordGuildId }, data: { disabled: true } })
}
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npx vitest run tests/domain/network.test.ts`
Expected: PASS (6 tests). Le test de concurrence doit montrer exactement un `fulfilled`.

- [ ] **Step 6: Commit**

```bash
git add src/domain/errors.ts src/domain/network.ts tests/domain/network.test.ts
git commit -m "feat: codes d'invitation et cycle de vie des serveurs partenaires"
```

---

### Task 6: Analyse de l'heure de raid

**Files:**
- Create: `src/domain/time.ts`
- Test: `tests/domain/time.test.ts`

**Interfaces:**
- Consumes: `RaidTimeInvalid` (Tâche 5)
- Produces: `parseRaidTime(input: string, timezone: string, now: Date): Date` — rend un instant UTC.

Cette tâche est isolée parce que le parsing d'heure concentre à lui seul la moitié des cas limites du produit : bascule sur le lendemain, fuseaux, heure déjà passée.

- [ ] **Step 1: Écrire le test**

Fichier `tests/domain/time.test.ts` :

```ts
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
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/domain/time.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/domain/time.ts`**

```ts
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

  let candidate: DateTime
  if (withDate) {
    const [, day, month, hour, minute] = withDate
    candidate = reference.set({
      day: Number(day), month: Number(month),
      hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0,
    })
    if (candidate.isValid && candidate <= reference) candidate = candidate.plus({ years: 1 })
  } else if (timeOnly) {
    const [, hour, minute] = timeOnly
    candidate = reference.set({
      hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0,
    })
    if (candidate.isValid && candidate <= reference) candidate = candidate.plus({ days: 1 })
  } else {
    throw new RaidTimeInvalid(`Could not read \`${trimmed}\` as a time. ${FORMAT_HELP}`)
  }

  if (!candidate.isValid) throw new RaidTimeInvalid(`\`${trimmed}\` is not a valid date. ${FORMAT_HELP}`)
  return candidate.toUTC().toJSDate()
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `npx vitest run tests/domain/time.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/time.ts tests/domain/time.test.ts
git commit -m "feat: analyse de l'heure de raid avec gestion des fuseaux"
```

---

### Task 7: Service d'annonces — brouillon, roster, publication

**Files:**
- Create: `src/domain/events.ts`, `tests/helpers/factories.ts`
- Test: `tests/domain/events.test.ts`

**Interfaces:**
- Consumes: `Db`, `listActiveGuilds` (Tâche 5), `findSpec` (Tâche 3), erreurs métier (Tâche 5)
- Produces:
  - `createDraft(db, { originGuildId, authorId, raidName, difficulty, scheduledAt }): Promise<Event>`
  - `addSlot(db, eventId, { className, specName }): Promise<Slot>`
  - `removeSlot(db, slotId): Promise<void>`
  - `setContact(db, eventId, contact): Promise<void>`
  - `publishEvent(db, eventId): Promise<{ targets: number }>`
  - `cancelEvent(db, eventId, actorId): Promise<void>`
  - `loadEventView(db, eventId): Promise<EventView>` avec `interface EventView { event: Event; slots: (Slot & { applications: Application[] })[] }`
  - `bumpVersions(tx, eventId, { public: boolean }): Promise<void>` — utilitaire réutilisé par les Tâches 9 et 11
- Fabriques de test : `makeGuild(db, overrides?)`, `makeDraft(db, overrides?)`, `makeSlot(db, eventId, overrides?)`

- [ ] **Step 1: Écrire les fabriques de test**

Fichier `tests/helpers/factories.ts` :

```ts
import type { Db } from '../../src/db/client.js'

export async function makeGuild(db: Db, overrides: Partial<{ discordGuildId: string; lfgChannelId: string | null }> = {}) {
  return db.guild.create({
    data: {
      discordGuildId: overrides.discordGuildId ?? `g${Math.random().toString(36).slice(2, 8)}`,
      lfgChannelId: overrides.lfgChannelId === undefined ? 'chan' : overrides.lfgChannelId,
      recruiterRoleIds: ['role-rl'],
      timezone: 'Europe/Paris',
    },
  })
}

export async function makeDraft(db: Db, guildId: string, authorId = 'rl-1') {
  return db.event.create({
    data: {
      originGuildId: guildId, authorId, authorContact: 'RaidLead#1234',
      raidName: 'Nerub-ar Palace', difficulty: 'HEROIC',
      scheduledAt: new Date('2026-09-01T19:00:00Z'),
    },
  })
}

export async function makeSlot(db: Db, eventId: string, className = 'MAGE', specName = 'ARCANE', position = 0) {
  return db.slot.create({
    data: { eventId, className, specName, role: 'DPS', position },
  })
}
```

- [ ] **Step 2: Écrire le test du service**

Fichier `tests/domain/events.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, removeSlot, publishEvent, cancelEvent, loadEventView } from '../../src/domain/events.js'
import { EmptyRoster, NoActivePartners, NotAuthorized } from '../../src/domain/errors.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

describe('construction du roster', () => {
  it('déduit le rôle de la spé et incrémente la position', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const tank = await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    const dps = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    expect(tank.role).toBe('TANK')
    expect(dps.position).toBe(1)
  })

  it('accepte deux fois la même spé — une ligne par place', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    expect(await testDb.slot.count({ where: { eventId: draft.id } })).toBe(2)
  })

  it('refuse une spé inconnue', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await expect(addSlot(testDb, draft.id, { className: 'MAGE', specName: 'BLOOD' })).rejects.toThrow()
  })

  it('retire une place du brouillon', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await removeSlot(testDb, slot.id)
    expect(await testDb.slot.count({ where: { eventId: draft.id } })).toBe(0)
  })
})

describe('publication', () => {
  it('crée une ligne d\'émission par partenaire actif plus le dashboard', async () => {
    const origin = await makeGuild(testDb, { discordGuildId: 'origin' })
    await makeGuild(testDb, { discordGuildId: 'partner-1' })
    await makeGuild(testDb, { discordGuildId: 'partner-2' })
    await makeGuild(testDb, { discordGuildId: 'sans-salon', lfgChannelId: null })

    const draft = await makeDraft(testDb, origin.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    const { targets } = await publishEvent(testDb, draft.id)

    expect(targets).toBe(3) // origin + 2 partenaires, le serveur sans salon est exclu
    expect(await testDb.eventMessage.count({ where: { kind: 'PUBLIC' } })).toBe(3)
    expect(await testDb.eventMessage.count({ where: { kind: 'DASHBOARD' } })).toBe(1)
    const published = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(published.status).toBe('PUBLISHED')
    expect(published.publicVersion).toBe(1)
  })

  it('refuse un roster vide et laisse l\'annonce en brouillon', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await expect(publishEvent(testDb, draft.id)).rejects.toBeInstanceOf(EmptyRoster)
    const untouched = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(untouched.status).toBe('DRAFT')
    expect(await testDb.eventMessage.count()).toBe(0)
  })

  it('refuse la publication si aucun partenaire n\'a de salon configuré', async () => {
    const guild = await makeGuild(testDb, { lfgChannelId: null })
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await expect(publishEvent(testDb, draft.id)).rejects.toBeInstanceOf(NoActivePartners)
  })
})

describe('annulation', () => {
  it('passe l\'annonce en CANCELLED et incrémente la version publique', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await publishEvent(testDb, draft.id)
    await cancelEvent(testDb, draft.id, 'rl-1')
    const event = await testDb.event.findUniqueOrThrow({ where: { id: draft.id } })
    expect(event.status).toBe('CANCELLED')
    expect(event.publicVersion).toBe(2)
  })

  it('refuse l\'annulation par un tiers', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await expect(cancelEvent(testDb, draft.id, 'intrus')).rejects.toBeInstanceOf(NotAuthorized)
  })
})

describe('loadEventView', () => {
  it('rend les places ordonnées avec leurs candidatures en attente', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const slot = await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await testDb.application.create({
      data: {
        slotId: slot.id, applicantId: 'p1', applicantTag: 'Pug', ignRealm: 'Pug-Hyjal',
        itemLevel: 626, logsUrl: 'https://warcraftlogs.com/x',
      },
    })
    const view = await loadEventView(testDb, draft.id)
    expect(view.slots).toHaveLength(1)
    expect(view.slots[0]!.applications).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Lancer les tests et vérifier l'échec**

Run: `npx vitest run tests/domain/events.test.ts`
Expected: FAIL — `src/domain/events.ts` absent.

- [ ] **Step 4: Implémenter `src/domain/events.ts`**

```ts
import type { Application, Difficulty, Event, Slot } from '@prisma/client'
import type { Db } from '../db/client.js'
import { findSpec } from '../config/wow.js'
import { listActiveGuilds } from './network.js'
import { EmptyRoster, NoActivePartners, NotAuthorized, DomainError } from './errors.js'

export interface EventView {
  event: Event
  slots: (Slot & { applications: Application[] })[]
}

export interface CreateDraftParams {
  originGuildId: string
  authorId: string
  raidName: string
  difficulty: Difficulty
  scheduledAt: Date
}

export function createDraft(db: Db, params: CreateDraftParams): Promise<Event> {
  return db.event.create({ data: { ...params, status: 'DRAFT' } })
}

export async function addSlot(db: Db, eventId: string, spec: { className: string; specName: string }): Promise<Slot> {
  const resolved = findSpec(spec.className, spec.specName)
  if (!resolved) throw new DomainError('spé inconnue', 'Unknown class or specialization.')
  const position = await db.slot.count({ where: { eventId } })
  return db.slot.create({
    data: {
      eventId, className: spec.className.toUpperCase(), specName: spec.specName.toUpperCase(),
      role: resolved.role, position,
    },
  })
}

export async function removeSlot(db: Db, slotId: string): Promise<void> {
  await db.slot.delete({ where: { id: slotId } })
}

export async function setContact(db: Db, eventId: string, contact: string): Promise<void> {
  await db.event.update({ where: { id: eventId }, data: { authorContact: contact } })
}

/**
 * Incrémente les compteurs de version. Toujours appelé DANS la transaction qui
 * porte le changement métier : c'est ce qui garantit qu'un message publié ne
 * peut pas refléter un état que la base n'a pas validé.
 */
export async function bumpVersions(tx: Db, eventId: string, options: { public: boolean }): Promise<void> {
  await tx.event.update({
    where: { id: eventId },
    data: {
      dashboardVersion: { increment: 1 },
      ...(options.public ? { publicVersion: { increment: 1 } } : {}),
    },
  })
}

export async function publishEvent(db: Db, eventId: string): Promise<{ targets: number }> {
  return db.$transaction(async (tx) => {
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, include: { originGuild: true } })
    const slots = await tx.slot.count({ where: { eventId } })
    if (slots === 0) throw new EmptyRoster()

    const guilds = await listActiveGuilds(tx)
    if (guilds.length === 0) throw new NoActivePartners()

    await tx.eventMessage.createMany({
      data: guilds.map((guild) => ({
        eventId, guildId: guild.discordGuildId,
        channelId: guild.lfgChannelId!, kind: 'PUBLIC' as const,
      })),
    })
    // Le dashboard n'a pas encore de salon : il sera résolu par le worker,
    // qui tente le DM puis se rabat sur un thread privé.
    await tx.eventMessage.create({
      data: {
        eventId, guildId: event.originGuild.discordGuildId,
        channelId: '', kind: 'DASHBOARD',
      },
    })
    await tx.event.update({
      where: { id: eventId },
      data: { status: 'PUBLISHED', publicVersion: { increment: 1 }, dashboardVersion: { increment: 1 } },
    })
    return { targets: guilds.length }
  })
}

export async function cancelEvent(db: Db, eventId: string, actorId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } })
    if (event.authorId !== actorId) throw new NotAuthorized('cancelling this listing')
    await tx.event.update({ where: { id: eventId }, data: { status: 'CANCELLED' } })
    await bumpVersions(tx, eventId, { public: true })
  })
}

export async function loadEventView(db: Db, eventId: string): Promise<EventView> {
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } })
  const slots = await db.slot.findMany({
    where: { eventId },
    orderBy: { position: 'asc' },
    include: { applications: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } } },
  })
  return { event, slots }
}
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npx vitest run tests/domain/events.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add src/domain/events.ts tests/domain/events.test.ts tests/helpers/factories.ts
git commit -m "feat: brouillon, roster et publication des annonces"
```

---

### Task 8: Rendu des messages

**Files:**
- Create: `src/broadcast/render.ts`
- Test: `tests/broadcast/render.test.ts`

**Interfaces:**
- Consumes: `EventView` (Tâche 7), `EmojiMap`/`classEmoji` (Tâche 3), `MessagePayload` (Tâche 4), `buildCustomId` (défini ici, réutilisé par la Tâche 12)
- Produces:
  - `renderPublicMessage(view: EventView, emojis: EmojiMap): MessagePayload`
  - `renderDashboardMessage(view: EventView, emojis: EmojiMap): MessagePayload`
  - `MAX_SELECT_OPTIONS = 25`

Fonctions pures, sans import de discord.js : elles produisent les structures JSON de l'API Discord directement (`type: 1` action row, `type: 2` bouton, `type: 3` select).

- [ ] **Step 1: Écrire le test**

Fichier `tests/broadcast/render.test.ts` :

```ts
import { describe, it, expect } from 'vitest'
import { renderPublicMessage, renderDashboardMessage } from '../../src/broadcast/render.js'
import type { EventView } from '../../src/domain/events.js'

const emojis = { MAGE: '<:mage:1>', PALADIN: '<:pala:2>' }

function view(overrides: Partial<EventView['event']> = {}, slots: Partial<EventView['slots'][number]>[] = []): EventView {
  return {
    event: {
      id: 'e1', originGuildId: 'g1', authorId: 'rl', authorContact: 'RL#1',
      raidName: 'Nerub-ar Palace', difficulty: 'HEROIC',
      scheduledAt: new Date('2026-09-01T19:00:00Z'), status: 'PUBLISHED',
      publicVersion: 1, dashboardVersion: 1, dashboardChannelId: null,
      dashboardMessageId: null, createdAt: new Date(), ...overrides,
    } as EventView['event'],
    slots: slots.map((s, i) => ({
      id: `s${i}`, eventId: 'e1', className: 'MAGE', specName: 'ARCANE', role: 'DPS',
      status: 'OPEN', acceptedApplicationId: null, position: i, applications: [], ...s,
    })) as EventView['slots'],
  }
}

describe('embed public', () => {
  it('affiche le titre, un timestamp dynamique et les places ouvertes', () => {
    const payload = renderPublicMessage(view({}, [{}]), emojis)
    const embed = payload.embeds[0] as { title: string; description: string }
    expect(embed.title).toBe('🚨 LFG - Nerub-ar Palace (Heroic)')
    expect(embed.description).toContain('<t:1788375600:F>') // instant du raid en secondes
    expect(embed.description).toContain('🔸 <:mage:1> Arcane (Open)')
  })

  it('agrège les places identiques et marque celles pourvues', () => {
    const payload = renderPublicMessage(view({}, [{}, {}, { status: 'FILLED' }]), emojis)
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description).toContain('🔸 <:mage:1> Arcane (2 Open)')
    expect(embed.description).toContain('✅ <:mage:1> Arcane (1 Filled)')
  })

  it('préfixe le titre et désactive le bouton quand l\'annonce est close', () => {
    for (const [status, prefix] of [['COMPLETED', '[COMPLETED]'], ['EXPIRED', '[EXPIRED]'], ['CANCELLED', '[CANCELLED]']] as const) {
      const payload = renderPublicMessage(view({ status }, [{ status: 'FILLED' }]), emojis)
      const embed = payload.embeds[0] as { title: string }
      const row = payload.components[0] as { components: { disabled: boolean }[] }
      expect(embed.title.startsWith(prefix)).toBe(true)
      expect(row.components[0]!.disabled).toBe(true)
    }
  })

  it('porte un bouton Apply actif référençant l\'annonce', () => {
    const payload = renderPublicMessage(view({}, [{}]), emojis)
    const row = payload.components[0] as { components: { custom_id: string; label: string; disabled: boolean }[] }
    expect(row.components[0]).toMatchObject({ custom_id: 'pug:1:app:open:e1', label: '⚔️ Apply', disabled: false })
  })
})

describe('dashboard', () => {
  it('liste les candidats sous leur place avec un select d\'acceptation', () => {
    const payload = renderDashboardMessage(
      view({}, [{
        applications: [
          { id: 'a1', applicantTag: 'PugA', ignRealm: 'PugA-Hyjal', itemLevel: 620, logsUrl: 'https://l/1', comment: 'Dispo tôt' },
          { id: 'a2', applicantTag: 'PugB', ignRealm: 'PugB-Archimonde', itemLevel: 626, logsUrl: 'https://l/2', comment: null },
        ],
      }] as never),
      emojis,
    )
    const embed = payload.embeds[0] as { description: string }
    expect(embed.description).toContain('PugA-Hyjal')
    expect(embed.description).toContain('iLvl: 626')
    const select = (payload.components[0] as { components: { custom_id: string; options: unknown[] }[] }).components[0]!
    expect(select.custom_id).toBe('pug:1:dash:accept:s0')
    expect(select.options).toHaveLength(2)
  })

  it('n\'affiche pas de select pour une place déjà pourvue', () => {
    const payload = renderDashboardMessage(view({}, [{ status: 'FILLED' }]), emojis)
    expect(payload.components.filter((c) => (c as { components: { type: number }[] }).components[0]!.type === 3)).toHaveLength(0)
  })

  it('tronque au-delà de 25 candidats en annonçant le nombre masqué', () => {
    const applications = Array.from({ length: 30 }, (_, i) => ({
      id: `a${i}`, applicantTag: `P${i}`, ignRealm: `P${i}-R`, itemLevel: 600 + i,
      logsUrl: 'https://l', comment: null,
    }))
    const payload = renderDashboardMessage(view({}, [{ applications }] as never), emojis)
    const embed = payload.embeds[0] as { description: string }
    const select = (payload.components[0] as { components: { options: unknown[] }[] }).components[0]!
    expect(select.options).toHaveLength(25)
    expect(embed.description).toContain('5 more')
  })

  it('affiche un message d\'attente quand personne n\'a postulé', () => {
    const payload = renderDashboardMessage(view({}, [{}]), emojis)
    expect((payload.embeds[0] as { description: string }).description).toContain('No applications yet')
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/broadcast/render.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/broadcast/render.ts`**

```ts
import type { EventView } from '../domain/events.js'
import type { MessagePayload } from './gateway.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { findSpec } from '../config/wow.js'

export const MAX_SELECT_OPTIONS = 25
const CLOSED: Record<string, string> = { COMPLETED: '[COMPLETED]', EXPIRED: '[EXPIRED]', CANCELLED: '[CANCELLED]' }
const DIFFICULTY_LABEL: Record<string, string> = { NORMAL: 'Normal', HEROIC: 'Heroic', MYTHIC: 'Mythic' }

export function buildCustomId(domain: string, action: string, id: string): string {
  return `pug:1:${domain}:${action}:${id}`
}

function specLabel(className: string, specName: string): string {
  return findSpec(className, specName)?.label ?? specName
}

function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`
}

export function renderPublicMessage(view: EventView, emojis: EmojiMap): MessagePayload {
  const { event, slots } = view
  const closed = CLOSED[event.status]
  const title = `${closed ? `${closed} ` : ''}🚨 LFG - ${event.raidName} (${DIFFICULTY_LABEL[event.difficulty]})`

  // Agrégation par (classe, spé, statut) : le RL saisit une ligne par place,
  // le lecteur veut une ligne par besoin.
  const groups = new Map<string, { className: string; specName: string; filled: boolean; count: number }>()
  for (const slot of slots) {
    const filled = slot.status === 'FILLED'
    const key = `${slot.className}|${slot.specName}|${filled}`
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { className: slot.className, specName: slot.specName, filled, count: 1 })
  }

  const lines = [...groups.values()].map((g) => {
    const label = `${classEmoji(emojis, g.className)} ${specLabel(g.className, g.specName)}`
    const state = g.count > 1 ? `(${g.count} ${g.filled ? 'Filled' : 'Open'})` : `(${g.filled ? 'Filled' : 'Open'})`
    return `${g.filled ? '✅' : '🔸'} ${label} ${state}`
  })

  return {
    embeds: [{
      title,
      description: [
        `🕒 ${discordTimestamp(event.scheduledAt)}`,
        `👤 Contact: ${event.authorContact}`,
        '',
        '**Looking for:**',
        ...lines,
      ].join('\n'),
      color: 0x5865f2,
      footer: { text: 'PugStone LFG network' },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 1, label: '⚔️ Apply',
        custom_id: buildCustomId('app', 'open', event.id),
        disabled: event.status !== 'PUBLISHED',
      }],
    }],
  }
}

export function renderDashboardMessage(view: EventView, emojis: EmojiMap): MessagePayload {
  const { event, slots } = view
  const sections: string[] = []
  const components: unknown[] = []

  for (const slot of slots) {
    const label = `${classEmoji(emojis, slot.className)} ${specLabel(slot.className, slot.specName)}`
    if (slot.status === 'FILLED') {
      sections.push(`✅ **${label}** — filled`)
      continue
    }
    const shown = slot.applications.slice(0, MAX_SELECT_OPTIONS)
    const hidden = slot.applications.length - shown.length
    sections.push(
      `🔹 **${label}** (open)`,
      ...(shown.length === 0
        ? ['   _No applications yet_']
        : shown.map((a) => `   \`${a.ignRealm}\` | iLvl: ${a.itemLevel} | [Logs](${a.logsUrl})${a.comment ? ` | "${a.comment}"` : ''}`)),
      ...(hidden > 0 ? [`   _…and ${hidden} more not shown_`] : []),
    )
    if (shown.length > 0) {
      components.push({
        type: 1,
        components: [{
          type: 3,
          custom_id: buildCustomId('dash', 'accept', slot.id),
          placeholder: `Accept for ${specLabel(slot.className, slot.specName)}`,
          options: shown.map((a) => ({
            label: `${a.ignRealm} — iLvl ${a.itemLevel}`.slice(0, 100),
            value: a.id,
            description: (a.comment ?? '').slice(0, 100) || undefined,
          })),
        }],
      })
    }
  }

  components.push({
    type: 1,
    components: [{
      type: 2, style: 4, label: 'Close listing',
      custom_id: buildCustomId('dash', 'close', event.id),
      disabled: event.status !== 'PUBLISHED',
    }],
  })

  return {
    embeds: [{
      title: `📋 ${event.raidName} (${DIFFICULTY_LABEL[event.difficulty]}) — ${discordTimestamp(event.scheduledAt)}`,
      description: sections.join('\n'),
      color: 0x2b2d31,
    }],
    components,
  }
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `npx vitest run tests/broadcast/render.test.ts`
Expected: PASS (8 tests). Le timestamp attendu dans le premier test doit correspondre à `Math.floor(Date.parse('2026-09-01T19:00:00Z')/1000)` : ajuster la valeur littérale si nécessaire plutôt que d'assouplir l'assertion.

- [ ] **Step 5: Vérifier que la contrainte d'architecture tient toujours**

Run: `npx vitest run tests/architecture.test.ts`
Expected: PASS — `render.ts` ne doit importer aucun module discord.js.

- [ ] **Step 6: Commit**

```bash
git add src/broadcast/render.ts tests/broadcast/render.test.ts
git commit -m "feat: rendu des embeds public et dashboard"
```

---

### Task 9: Worker d'émission

**Files:**
- Create: `src/broadcast/outbox.ts`
- Test: `tests/broadcast/outbox.test.ts`

**Interfaces:**
- Consumes: `DiscordGateway`, `classifyDiscordError` (Tâche 4), `renderPublicMessage`/`renderDashboardMessage` (Tâche 8), `loadEventView` (Tâche 7), `markGuildNeedsAttention` (Tâche 5)
- Produces:
  - `interface OutboxDeps { db: Db; gateway: DiscordGateway; emojis: EmojiMap; now: () => Date; concurrency?: number }`
  - `runOutboxTick(deps: OutboxDeps): Promise<{ processed: number; failed: number }>`
  - `backoffDelayMs(attempts: number): number`
  - `MAX_ATTEMPTS = 8`

Le dashboard demande un traitement particulier : sa ligne naît sans `channelId`. Le worker tente d'abord le DM au Raid Leader ; en cas d'échec, il crée un thread privé dans le salon LFG du serveur émetteur et y bascule définitivement.

- [ ] **Step 1: Écrire le test**

Fichier `tests/broadcast/outbox.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { FakeGateway, discordError } from '../helpers/fake-gateway.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { runOutboxTick, backoffDelayMs, MAX_ATTEMPTS } from '../../src/broadcast/outbox.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>' }
let clock = new Date('2026-08-06T18:00:00Z')
const deps = (gateway: FakeGateway) => ({ db: testDb, gateway, emojis, now: () => clock })

async function publishedEvent() {
  const origin = await makeGuild(testDb, { discordGuildId: 'origin' })
  await makeGuild(testDb, { discordGuildId: 'partner' })
  const draft = await makeDraft(testDb, origin.id)
  await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
  await publishEvent(testDb, draft.id)
  return draft
}

describe('publication initiale', () => {
  it('envoie un message par cible et mémorise les identifiants', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    const result = await runOutboxTick(deps(gateway))

    expect(result.processed).toBe(3) // 2 publics + 1 dashboard
    expect(gateway.sent).toHaveLength(2)
    expect(gateway.dms).toHaveLength(1)
    const rows = await testDb.eventMessage.findMany({ where: { eventId: event.id } })
    expect(rows.every((r) => r.messageId !== null && r.syncedVersion === 1)).toBe(true)
  })

  it('ne fait rien au tick suivant si rien n\'a changé', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))
    const second = await runOutboxTick(deps(gateway))
    expect(second.processed).toBe(0)
    expect(gateway.edited).toHaveLength(0)
  })
})

describe('mises à jour', () => {
  it('édite les messages existants quand la version publique augmente', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    await testDb.event.update({ where: { id: event.id }, data: { publicVersion: { increment: 1 } } })
    await runOutboxTick(deps(gateway))
    expect(gateway.edited).toHaveLength(2)
    expect(gateway.sent).toHaveLength(2) // aucun nouvel envoi
  })

  it('coalesce plusieurs changements en une seule édition', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    await testDb.event.update({ where: { id: event.id }, data: { publicVersion: { increment: 3 } } })
    await runOutboxTick(deps(gateway))
    expect(gateway.edited).toHaveLength(2)
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.syncedVersion === 4)).toBe(true)
  })

  it('n\'édite pas le message public quand seul le dashboard a changé', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))

    await testDb.event.update({ where: { id: event.id }, data: { dashboardVersion: { increment: 1 } } })
    await runOutboxTick(deps(gateway))
    expect(gateway.edited).toHaveLength(1)
    expect(gateway.edited[0]!.channelId).toBe('dm-rl-1')
  })
})

describe('échecs', () => {
  it('replanifie avec backoff sur erreur transitoire', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(500))
    const result = await runOutboxTick(deps(gateway))

    expect(result.failed).toBe(3)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { kind: 'PUBLIC' } })
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(clock.getTime())
    expect(row.lastError).toContain('500')
  })

  it('ignore les lignes dont le prochain essai est dans le futur', async () => {
    await publishedEvent()
    const failing = new FakeGateway()
    failing.failAlways(discordError(500))
    await runOutboxTick(deps(failing))

    const gateway = new FakeGateway()
    const result = await runOutboxTick(deps(gateway))
    expect(result.processed).toBe(0)
  })

  it('abandonne après MAX_ATTEMPTS tentatives', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(500))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runOutboxTick(deps(gateway))
      clock = new Date(clock.getTime() + 60 * 60 * 1000)
    }
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.disabled)).toBe(true)
  })

  it('marque le serveur NEEDS_ATTENTION sur permission manquante, sans réessayer', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(50013))
    await runOutboxTick(deps(gateway))

    const guild = await testDb.guild.findUniqueOrThrow({ where: { discordGuildId: 'partner' } })
    expect(guild.status).toBe('NEEDS_ATTENTION')
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { guildId: 'partner' } })
    expect(row.disabled).toBe(true)
  })

  it('désactive la ligne sans republier quand le message a été supprimé', async () => {
    const event = await publishedEvent()
    const gateway = new FakeGateway()
    await runOutboxTick(deps(gateway))
    await testDb.event.update({ where: { id: event.id }, data: { publicVersion: { increment: 1 } } })

    const gone = new FakeGateway()
    gone.failAlways(discordError(10008))
    await runOutboxTick(deps(gone))

    expect(gone.sent).toHaveLength(0)
    const rows = await testDb.eventMessage.findMany({ where: { kind: 'PUBLIC' } })
    expect(rows.every((r) => r.disabled)).toBe(true)
  })

  it('bascule le dashboard sur un thread privé quand les DM sont fermés', async () => {
    await publishedEvent()
    const gateway = new FakeGateway()
    gateway.failNext(discordError(50007)) // Cannot send messages to this user
    await runOutboxTick(deps(gateway))

    expect(gateway.threads).toHaveLength(1)
    const row = await testDb.eventMessage.findFirstOrThrow({ where: { kind: 'DASHBOARD' } })
    expect(row.channelId).toBe('thread-chan')
    expect(row.messageId).not.toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('croît de façon exponentielle et reste borné', () => {
    expect(backoffDelayMs(1)).toBeGreaterThanOrEqual(5_000)
    expect(backoffDelayMs(3)).toBeGreaterThan(backoffDelayMs(1))
    expect(backoffDelayMs(20)).toBeLessThanOrEqual(30 * 60 * 1000)
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/broadcast/outbox.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/broadcast/outbox.ts`**

```ts
import pLimit from 'p-limit'
import type { EventMessage } from '@prisma/client'
import type { Db } from '../db/client.js'
import type { EmojiMap } from '../config/emojis.js'
import { classifyDiscordError, type DiscordGateway, type MessagePayload } from './gateway.js'
import { renderDashboardMessage, renderPublicMessage } from './render.js'
import { loadEventView } from '../domain/events.js'
import { markGuildNeedsAttention } from '../domain/network.js'

export const MAX_ATTEMPTS = 8
const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 30 * 60 * 1000

export interface OutboxDeps {
  db: Db
  gateway: DiscordGateway
  emojis: EmojiMap
  now: () => Date
  concurrency?: number
}

/** Exponentiel plafonné, avec jitter pour éviter que toutes les cibles réessaient ensemble. */
export function backoffDelayMs(attempts: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS)
  return Math.round(exponential * (0.85 + Math.random() * 0.3))
}

interface Pending extends EventMessage {
  targetVersion: number
}

async function claimPending(db: Db, now: Date, limit: number): Promise<Pending[]> {
  // SKIP LOCKED : deux ticks qui se chevauchent se partagent le travail au lieu
  // de s'attendre, et aucun message n'est traité deux fois.
  return db.$queryRaw<Pending[]>`
    SELECT m.*, CASE WHEN m.kind = 'PUBLIC' THEN e."publicVersion" ELSE e."dashboardVersion" END AS "targetVersion"
    FROM "EventMessage" m
    JOIN "Event" e ON e.id = m."eventId"
    WHERE m.disabled = false
      AND m."nextAttemptAt" <= ${now}
      AND m."syncedVersion" < CASE WHEN m.kind = 'PUBLIC' THEN e."publicVersion" ELSE e."dashboardVersion" END
    ORDER BY m."nextAttemptAt" ASC
    LIMIT ${limit}
    FOR UPDATE OF m SKIP LOCKED
  `
}

async function handleFailure(deps: OutboxDeps, row: Pending, error: unknown): Promise<void> {
  const kind = classifyDiscordError(error)
  const message = error instanceof Error ? error.message : String(error)

  if (kind === 'MESSAGE_GONE') {
    // Un modérateur a supprimé le message : republier reviendrait à passer outre.
    await deps.db.eventMessage.update({ where: { id: row.id }, data: { disabled: true, lastError: message } })
    return
  }
  if (kind === 'TARGET_UNUSABLE') {
    await deps.db.eventMessage.update({ where: { id: row.id }, data: { disabled: true, lastError: message } })
    const guild = await deps.db.guild.findUnique({ where: { discordGuildId: row.guildId } })
    if (guild) await markGuildNeedsAttention(deps.db, guild.id, message)
    return
  }

  const attempts = row.attempts + 1
  await deps.db.eventMessage.update({
    where: { id: row.id },
    data: {
      attempts,
      lastError: message,
      disabled: attempts >= MAX_ATTEMPTS,
      nextAttemptAt: new Date(deps.now().getTime() + backoffDelayMs(attempts)),
    },
  })
}

async function deliverDashboard(deps: OutboxDeps, row: Pending, payload: MessagePayload, authorId: string, channelId: string | null) {
  if (row.messageId && row.channelId) {
    await deps.gateway.editMessage(row.channelId, row.messageId, payload)
    return { channelId: row.channelId, messageId: row.messageId }
  }
  try {
    const dm = await deps.gateway.sendDM(authorId, payload)
    return dm
  } catch (error) {
    if (classifyDiscordError(error) === 'TARGET_UNUSABLE' || !channelId) throw error
    // DM fermés : on bascule sur un thread privé dans le salon LFG du serveur émetteur.
    const thread = await deps.gateway.createPrivateThread(channelId, 'PugStone dashboard', authorId)
    const sent = await deps.gateway.sendMessage(thread.channelId, payload)
    return { channelId: thread.channelId, messageId: sent.messageId }
  }
}

export async function runOutboxTick(deps: OutboxDeps): Promise<{ processed: number; failed: number }> {
  const now = deps.now()
  const rows = await claimPending(deps.db, now, 100)
  const limit = pLimit(deps.concurrency ?? 5)
  let processed = 0
  let failed = 0

  await Promise.all(rows.map((row) => limit(async () => {
    try {
      const view = await loadEventView(deps.db, row.eventId)
      const payload = row.kind === 'PUBLIC'
        ? renderPublicMessage(view, deps.emojis)
        : renderDashboardMessage(view, deps.emojis)

      if (row.kind === 'DASHBOARD') {
        const origin = await deps.db.guild.findUnique({ where: { discordGuildId: row.guildId } })
        const result = await deliverDashboard(deps, row, payload, view.event.authorId, origin?.lfgChannelId ?? null)
        await deps.db.eventMessage.update({
          where: { id: row.id },
          data: { channelId: result.channelId, messageId: result.messageId, syncedVersion: row.targetVersion, attempts: 0, lastError: null },
        })
        await deps.db.event.update({
          where: { id: row.eventId },
          data: { dashboardChannelId: result.channelId, dashboardMessageId: result.messageId },
        })
      } else if (row.messageId) {
        await deps.gateway.editMessage(row.channelId, row.messageId, payload)
        await deps.db.eventMessage.update({
          where: { id: row.id },
          data: { syncedVersion: row.targetVersion, attempts: 0, lastError: null },
        })
      } else {
        const sent = await deps.gateway.sendMessage(row.channelId, payload)
        await deps.db.eventMessage.update({
          where: { id: row.id },
          data: { messageId: sent.messageId, syncedVersion: row.targetVersion, attempts: 0, lastError: null },
        })
      }
      processed += 1
    } catch (error) {
      failed += 1
      await handleFailure(deps, row, error)
    }
  })))

  return { processed, failed }
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `npx vitest run tests/broadcast/outbox.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/broadcast/outbox.ts tests/broadcast/outbox.test.ts
git commit -m "feat: worker d'emission avec backoff et bascule dashboard"
```

---

### Task 10: Candidatures et acceptation

**Files:**
- Create: `src/domain/applications.ts`
- Test: `tests/domain/applications.test.ts`

**Interfaces:**
- Consumes: `Db`, `bumpVersions` (Tâche 7), erreurs métier (Tâche 5)
- Produces:
  - `validateApplicationInput(raw: { ignRealm: string; itemLevel: string; logsUrl: string; comment?: string }): { ok: true; value: ValidatedApplication } | { ok: false; errors: string[] }`
  - `submitApplication(db, { slotId, applicantId, applicantTag, ...ValidatedApplication }): Promise<Application>`
  - `acceptApplication(db, { applicationId, actorId }): Promise<{ applicantId: string; contact: string; raidName: string; eventCompleted: boolean }>`
  - `openSlots(db, eventId): Promise<Slot[]>`

- [ ] **Step 1: Écrire le test**

Fichier `tests/domain/applications.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { validateApplicationInput, submitApplication, acceptApplication, openSlots } from '../../src/domain/applications.js'
import { SlotAlreadyFilled, NotAuthorized } from '../../src/domain/errors.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const input = { ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://www.warcraftlogs.com/character/eu/hyjal/pug' }

async function setup(slots = 1) {
  const guild = await makeGuild(testDb)
  const draft = await makeDraft(testDb, guild.id)
  const created = []
  for (let i = 0; i < slots; i++) created.push(await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' }))
  await publishEvent(testDb, draft.id)
  return { event: draft, slots: created }
}

const apply = (slotId: string, applicantId: string) =>
  submitApplication(testDb, {
    slotId, applicantId, applicantTag: applicantId,
    ignRealm: input.ignRealm, itemLevel: 626, logsUrl: input.logsUrl, comment: null,
  })

describe('validation de la saisie', () => {
  it('accepte une candidature complète', () => {
    const result = validateApplicationInput(input)
    expect(result.ok && result.value.itemLevel).toBe(626)
  })

  it('refuse un iLvl non numérique ou hors plage, en le disant', () => {
    for (const itemLevel of ['abc', '10', '9999']) {
      const result = validateApplicationInput({ ...input, itemLevel })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.errors.join(' ')).toMatch(/item level/i)
    }
  })

  it('refuse un lien qui n\'est pas sur warcraftlogs.com', () => {
    const result = validateApplicationInput({ ...input, logsUrl: 'https://exemple.com/x' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.join(' ')).toMatch(/warcraftlogs/i)
  })

  it('accumule toutes les erreurs en une seule réponse', () => {
    const result = validateApplicationInput({ ignRealm: '', itemLevel: 'x', logsUrl: 'nope' })
    expect(!result.ok && result.errors).toHaveLength(3)
  })
})

describe('candidature', () => {
  it('enregistre la candidature et incrémente uniquement la version dashboard', async () => {
    const { event, slots } = await setup()
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    await apply(slots[0]!.id, 'p1')
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.dashboardVersion).toBe(before.dashboardVersion + 1)
    expect(after.publicVersion).toBe(before.publicVersion)
  })

  it('met à jour la candidature existante au lieu d\'en créer une seconde', async () => {
    const { slots } = await setup()
    await apply(slots[0]!.id, 'p1')
    await submitApplication(testDb, {
      slotId: slots[0]!.id, applicantId: 'p1', applicantTag: 'p1',
      ignRealm: 'Pug-Kazzak', itemLevel: 630, logsUrl: input.logsUrl, comment: 'maj',
    })
    const rows = await testDb.application.findMany({ where: { slotId: slots[0]!.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.itemLevel).toBe(630)
  })

  it('refuse une candidature sur une place déjà pourvue', async () => {
    const { slots } = await setup()
    const app = await apply(slots[0]!.id, 'p1')
    await acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' })
    await expect(apply(slots[0]!.id, 'p2')).rejects.toBeInstanceOf(SlotAlreadyFilled)
  })
})

describe('acceptation', () => {
  it('retient un candidat, écarte les autres et pourvoit la place', async () => {
    const { slots } = await setup()
    const a = await apply(slots[0]!.id, 'p1')
    await apply(slots[0]!.id, 'p2')
    const result = await acceptApplication(testDb, { applicationId: a.id, actorId: 'rl-1' })

    expect(result.applicantId).toBe('p1')
    expect(result.eventCompleted).toBe(true)
    const slot = await testDb.slot.findUniqueOrThrow({ where: { id: slots[0]!.id } })
    expect(slot.status).toBe('FILLED')
    expect(slot.acceptedApplicationId).toBe(a.id)
    const discarded = await testDb.application.findMany({ where: { status: 'DISCARDED' } })
    expect(discarded).toHaveLength(1)
  })

  it('ne clôt l\'annonce que lorsque toutes les places sont pourvues', async () => {
    const { event, slots } = await setup(2)
    const first = await apply(slots[0]!.id, 'p1')
    const result = await acceptApplication(testDb, { applicationId: first.id, actorId: 'rl-1' })
    expect(result.eventCompleted).toBe(false)
    expect((await testDb.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PUBLISHED')

    const second = await apply(slots[1]!.id, 'p2')
    await acceptApplication(testDb, { applicationId: second.id, actorId: 'rl-1' })
    expect((await testDb.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('COMPLETED')
  })

  it('incrémente les deux compteurs de version', async () => {
    const { event, slots } = await setup()
    const app = await apply(slots[0]!.id, 'p1')
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    await acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' })
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.publicVersion).toBeGreaterThan(before.publicVersion)
    expect(after.dashboardVersion).toBeGreaterThan(before.dashboardVersion)
  })

  it('refuse l\'acceptation par quelqu\'un d\'autre que l\'auteur', async () => {
    const { slots } = await setup()
    const app = await apply(slots[0]!.id, 'p1')
    await expect(acceptApplication(testDb, { applicationId: app.id, actorId: 'intrus' }))
      .rejects.toBeInstanceOf(NotAuthorized)
  })
})

describe('concurrence', () => {
  it('n\'accepte qu\'un seul candidat sur deux acceptations simultanées', async () => {
    const { slots } = await setup()
    const a = await apply(slots[0]!.id, 'p1')
    const b = await apply(slots[0]!.id, 'p2')

    const results = await Promise.allSettled([
      acceptApplication(testDb, { applicationId: a.id, actorId: 'rl-1' }),
      acceptApplication(testDb, { applicationId: b.id, actorId: 'rl-1' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await testDb.application.count({ where: { status: 'ACCEPTED' } })).toBe(1)
  })

  it('sérialise deux candidatures simultanées sur la dernière place', async () => {
    const { slots } = await setup()
    const results = await Promise.allSettled([apply(slots[0]!.id, 'p1'), apply(slots[0]!.id, 'p2')])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(await testDb.application.count()).toBe(results.filter((r) => r.status === 'fulfilled').length)
  })
})

describe('openSlots', () => {
  it('ne rend que les places encore ouvertes', async () => {
    const { event, slots } = await setup(2)
    const app = await apply(slots[0]!.id, 'p1')
    await acceptApplication(testDb, { applicationId: app.id, actorId: 'rl-1' })
    const open = await openSlots(testDb, event.id)
    expect(open.map((s) => s.id)).toEqual([slots[1]!.id])
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/domain/applications.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/domain/applications.ts`**

```ts
import type { Application, Slot } from '@prisma/client'
import type { Db } from '../db/client.js'
import { bumpVersions } from './events.js'
import { EventClosed, NotAuthorized, SlotAlreadyFilled, SlotNotFound } from './errors.js'

const MIN_ILVL = 100
const MAX_ILVL = 1500
const ALLOWED_LOGS_HOSTS = ['warcraftlogs.com', 'www.warcraftlogs.com']

export interface ValidatedApplication {
  ignRealm: string
  itemLevel: number
  logsUrl: string
  comment: string | null
}

export type ValidationResult =
  | { ok: true; value: ValidatedApplication }
  | { ok: false; errors: string[] }

/**
 * Discord ne conserve pas la saisie d'un modal refusé : le message d'erreur doit
 * lister tous les problèmes d'un coup, sinon le joueur ressaisit trois fois.
 */
export function validateApplicationInput(raw: {
  ignRealm: string
  itemLevel: string
  logsUrl: string
  comment?: string | null
}): ValidationResult {
  const errors: string[] = []

  const ignRealm = raw.ignRealm.trim()
  if (ignRealm.length < 3 || ignRealm.length > 64) {
    errors.push('In-game name & realm must be between 3 and 64 characters (e.g. `Pug-Hyjal`).')
  }

  const itemLevel = Number(raw.itemLevel.trim())
  if (!Number.isInteger(itemLevel) || itemLevel < MIN_ILVL || itemLevel > MAX_ILVL) {
    errors.push(`Item level must be a whole number between ${MIN_ILVL} and ${MAX_ILVL}.`)
  }

  let logsUrl = ''
  try {
    const parsed = new URL(raw.logsUrl.trim())
    if (!ALLOWED_LOGS_HOSTS.includes(parsed.hostname)) throw new Error('host')
    logsUrl = parsed.toString()
  } catch {
    errors.push('WarcraftLogs link must be a full URL on warcraftlogs.com.')
  }

  const comment = raw.comment?.trim() ? raw.comment.trim().slice(0, 300) : null
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { ignRealm, itemLevel, logsUrl, comment } }
}

export interface SubmitParams extends ValidatedApplication {
  slotId: string
  applicantId: string
  applicantTag: string
}

export async function submitApplication(db: Db, params: SubmitParams): Promise<Application> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; eventId: string; status: string }[]>`
      SELECT id, "eventId", status FROM "Slot" WHERE id = ${params.slotId} FOR UPDATE
    `
    const slot = locked[0]
    if (!slot) throw new SlotNotFound()
    if (slot.status === 'FILLED') throw new SlotAlreadyFilled()

    const event = await tx.event.findUniqueOrThrow({ where: { id: slot.eventId } })
    if (event.status !== 'PUBLISHED') throw new EventClosed()

    const application = await tx.application.upsert({
      where: { slotId_applicantId: { slotId: params.slotId, applicantId: params.applicantId } },
      create: {
        slotId: params.slotId, applicantId: params.applicantId, applicantTag: params.applicantTag,
        ignRealm: params.ignRealm, itemLevel: params.itemLevel, logsUrl: params.logsUrl, comment: params.comment,
      },
      update: {
        applicantTag: params.applicantTag, ignRealm: params.ignRealm, itemLevel: params.itemLevel,
        logsUrl: params.logsUrl, comment: params.comment, status: 'PENDING',
      },
    })
    await bumpVersions(tx, slot.eventId, { public: false })
    return application
  })
}

export interface AcceptResult {
  applicantId: string
  contact: string
  raidName: string
  eventCompleted: boolean
}

export async function acceptApplication(db: Db, params: { applicationId: string; actorId: string }): Promise<AcceptResult> {
  return db.$transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({
      where: { id: params.applicationId },
      include: { slot: { include: { event: true } } },
    })
    const { slot } = application
    if (slot.event.authorId !== params.actorId) throw new NotAuthorized('accepting applications for this listing')
    if (slot.event.status !== 'PUBLISHED') throw new EventClosed()

    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "Slot" WHERE id = ${slot.id} FOR UPDATE
    `
    if (locked[0]?.status === 'FILLED') throw new SlotAlreadyFilled()

    await tx.application.update({ where: { id: application.id }, data: { status: 'ACCEPTED' } })
    await tx.application.updateMany({
      where: { slotId: slot.id, id: { not: application.id }, status: 'PENDING' },
      data: { status: 'DISCARDED' },
    })
    await tx.slot.update({
      where: { id: slot.id },
      data: { status: 'FILLED', acceptedApplicationId: application.id },
    })

    const stillOpen = await tx.slot.count({ where: { eventId: slot.eventId, status: 'OPEN' } })
    const eventCompleted = stillOpen === 0
    if (eventCompleted) {
      await tx.event.update({ where: { id: slot.eventId }, data: { status: 'COMPLETED' } })
    }
    await bumpVersions(tx, slot.eventId, { public: true })

    return {
      applicantId: application.applicantId,
      contact: slot.event.authorContact,
      raidName: slot.event.raidName,
      eventCompleted,
    }
  })
}

export function openSlots(db: Db, eventId: string): Promise<Slot[]> {
  return db.slot.findMany({ where: { eventId, status: 'OPEN' }, orderBy: { position: 'asc' } })
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `npx vitest run tests/domain/applications.test.ts`
Expected: PASS (14 tests). Les deux tests de concurrence sont les plus importants du projet : s'ils échouent de façon intermittente, le verrou est mal posé — ne pas les rendre tolérants.

- [ ] **Step 5: Commit**

```bash
git add src/domain/applications.ts tests/domain/applications.test.ts
git commit -m "feat: candidatures et acceptation avec verrouillage des places"
```

---

### Task 11: Planificateur — expiration et rétention

**Files:**
- Create: `src/scheduler/expiration.ts`, `src/scheduler/retention.ts`
- Test: `tests/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `Db`
- Produces:
  - `expireDueEvents(db, now: Date): Promise<number>`
  - `purgeOldEvents(db, now: Date, retentionDays?: number): Promise<number>`

- [ ] **Step 1: Écrire le test**

Fichier `tests/scheduler/scheduler.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { expireDueEvents } from '../../src/scheduler/expiration.js'
import { purgeOldEvents } from '../../src/scheduler/retention.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

async function published(scheduledAt: Date) {
  const guild = await makeGuild(testDb)
  const draft = await makeDraft(testDb, guild.id)
  await testDb.event.update({ where: { id: draft.id }, data: { scheduledAt } })
  await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
  await publishEvent(testDb, draft.id)
  return draft
}

describe('expiration', () => {
  it('expire les annonces dont l\'heure est passée et incrémente la version publique', async () => {
    const event = await published(new Date('2026-08-06T18:00:00Z'))
    const before = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })

    const count = await expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z'))
    expect(count).toBe(1)
    const after = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.status).toBe('EXPIRED')
    expect(after.publicVersion).toBe(before.publicVersion + 1)
  })

  it('laisse intactes les annonces à venir', async () => {
    await published(new Date('2026-08-09T18:00:00Z'))
    expect(await expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z'))).toBe(0)
  })

  it('ne touche ni aux annonces closes ni aux brouillons', async () => {
    const guild = await makeGuild(testDb)
    await makeDraft(testDb, guild.id) // reste en DRAFT
    const done = await published(new Date('2026-08-06T18:00:00Z'))
    await testDb.event.update({ where: { id: done.id }, data: { status: 'COMPLETED' } })

    expect(await expireDueEvents(testDb, new Date('2026-08-06T19:00:00Z'))).toBe(0)
  })

  it('est idempotent : un second passage n\'incrémente plus la version', async () => {
    const event = await published(new Date('2026-08-06T18:00:00Z'))
    await expireDueEvents(testDb, new Date('2026-08-06T18:01:00Z'))
    const first = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    await expireDueEvents(testDb, new Date('2026-08-06T18:02:00Z'))
    const second = await testDb.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(second.publicVersion).toBe(first.publicVersion)
  })
})

describe('rétention', () => {
  it('supprime les annonces terminées au-delà de la période de conservation', async () => {
    const event = await published(new Date('2026-06-01T18:00:00Z'))
    await testDb.event.update({ where: { id: event.id }, data: { status: 'EXPIRED' } })

    const removed = await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)
    expect(removed).toBe(1)
    expect(await testDb.event.count()).toBe(0)
    expect(await testDb.slot.count()).toBe(0)
    expect(await testDb.eventMessage.count()).toBe(0)
  })

  it('conserve les annonces encore actives, même anciennes', async () => {
    await published(new Date('2026-06-01T18:00:00Z'))
    expect(await purgeOldEvents(testDb, new Date('2026-08-06T18:00:00Z'), 30)).toBe(0)
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/scheduler/scheduler.test.ts`
Expected: FAIL — modules absents.

- [ ] **Step 3: Implémenter `src/scheduler/expiration.ts`**

```ts
import type { Db } from '../db/client.js'

/**
 * Passe en EXPIRED les annonces dont l'heure de raid est dépassée.
 * Le filtre sur PUBLISHED rend l'opération idempotente : une annonce déjà
 * expirée n'est plus sélectionnée, donc sa version n'est plus incrémentée.
 */
export async function expireDueEvents(db: Db, now: Date): Promise<number> {
  const due = await db.event.findMany({
    where: { status: 'PUBLISHED', scheduledAt: { lte: now } },
    select: { id: true },
  })
  if (due.length === 0) return 0

  await db.event.updateMany({
    where: { id: { in: due.map((e) => e.id) } },
    data: { status: 'EXPIRED', publicVersion: { increment: 1 }, dashboardVersion: { increment: 1 } },
  })
  return due.length
}
```

- [ ] **Step 4: Implémenter `src/scheduler/retention.ts`**

```ts
import type { Db } from '../db/client.js'

const DEFAULT_RETENTION_DAYS = 30

/** Les places, candidatures et lignes d'émission partent en cascade avec l'annonce. */
export async function purgeOldEvents(db: Db, now: Date, retentionDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const result = await db.event.deleteMany({
    where: {
      status: { in: ['COMPLETED', 'EXPIRED', 'CANCELLED'] },
      scheduledAt: { lt: cutoff },
    },
  })
  return result.count
}
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npx vitest run tests/scheduler/scheduler.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/scheduler tests/scheduler
git commit -m "feat: expiration automatique et purge des annonces anciennes"
```

---

### Task 12: Routeur d'interactions et implémentation Discord

**Files:**
- Create: `src/bot/router.ts`, `src/bot/gateway.ts`, `src/bot/client.ts`, `src/logger.ts`
- Test: `tests/bot/router.test.ts`

**Interfaces:**
- Consumes: `buildCustomId` (Tâche 8), `DiscordGateway` (Tâche 4), `env` (Tâche 1)
- Produces:
  - `parseCustomId(customId: string): { domain: string; action: string; id: string } | null`
  - `type InteractionHandler = (ctx: HandlerContext) => Promise<void>` avec `interface HandlerContext { interaction: Interaction; id: string; deps: BotDeps }`
  - `registerHandler(domain: string, action: string, handler: InteractionHandler): void`
  - `dispatchInteraction(interaction: Interaction, deps: BotDeps): Promise<void>`
  - `class DiscordJsGateway implements DiscordGateway`
  - `logger` (pino)

- [ ] **Step 1: Écrire le test du routeur**

Fichier `tests/bot/router.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCustomId, registerHandler, dispatchInteraction, resetHandlers } from '../../src/bot/router.js'
import { buildCustomId } from '../../src/broadcast/render.js'

function fakeInteraction(customId: string) {
  return {
    customId,
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(resetHandlers)

describe('parseCustomId', () => {
  it('analyse un identifiant bien formé', () => {
    expect(parseCustomId(buildCustomId('app', 'open', 'e1'))).toEqual({ domain: 'app', action: 'open', id: 'e1' })
  })

  it('rejette un préfixe absent, une version inconnue ou un format incomplet', () => {
    expect(parseCustomId('autre:1:app:open:e1')).toBeNull()
    expect(parseCustomId('pug:2:app:open:e1')).toBeNull()
    expect(parseCustomId('pug:1:app:open')).toBeNull()
  })

  it('produit un identifiant qui tient dans la limite Discord', () => {
    expect(buildCustomId('dash', 'accept', 'c'.repeat(25)).length).toBeLessThanOrEqual(100)
  })
})

describe('dispatchInteraction', () => {
  it('appelle le handler enregistré avec l\'identifiant extrait', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    registerHandler('app', 'open', handler)
    await dispatchInteraction(fakeInteraction(buildCustomId('app', 'open', 'e1')) as never, {} as never)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })

  it('répond une erreur générique plutôt que de laisser l\'interaction sans réponse', async () => {
    registerHandler('app', 'open', async () => { throw new Error('boom') })
    const interaction = fakeInteraction(buildCustomId('app', 'open', 'e1'))
    await dispatchInteraction(interaction as never, {} as never)
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
  })

  it('transforme une erreur métier en message utilisateur explicite', async () => {
    const { EventClosed } = await import('../../src/domain/errors.js')
    registerHandler('app', 'open', async () => { throw new EventClosed() })
    const interaction = fakeInteraction(buildCustomId('app', 'open', 'e1'))
    await dispatchInteraction(interaction as never, {} as never)
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer accepting') }),
    )
  })

  it('ignore silencieusement un identifiant inconnu', async () => {
    const interaction = fakeInteraction('bouton-d-un-autre-bot')
    await expect(dispatchInteraction(interaction as never, {} as never)).resolves.toBeUndefined()
    expect(interaction.reply).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/bot/router.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/logger.ts`**

```ts
import pino from 'pino'
import { env } from './config/env.js'

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
export type Logger = typeof logger
```

- [ ] **Step 4: Implémenter `src/bot/router.ts`**

```ts
import type { Interaction } from 'discord.js'
import type { Db } from '../db/client.js'
import type { DiscordGateway } from '../broadcast/gateway.js'
import type { EmojiMap } from '../config/emojis.js'
import { DomainError } from '../domain/errors.js'
import { logger } from '../logger.js'

export interface BotDeps {
  db: Db
  gateway: DiscordGateway
  emojis: EmojiMap
  ownerId: string
}

export interface HandlerContext {
  interaction: Interaction
  id: string
  deps: BotDeps
}

export type InteractionHandler = (ctx: HandlerContext) => Promise<void>

const PREFIX = 'pug'
const VERSION = '1'
const handlers = new Map<string, InteractionHandler>()

export function registerHandler(domain: string, action: string, handler: InteractionHandler): void {
  handlers.set(`${domain}:${action}`, handler)
}

/** Réservé aux tests : repart d'une table d'aiguillage vide. */
export function resetHandlers(): void {
  handlers.clear()
}

export function parseCustomId(customId: string): { domain: string; action: string; id: string } | null {
  const parts = customId.split(':')
  if (parts.length !== 5) return null
  const [prefix, version, domain, action, id] = parts as [string, string, string, string, string]
  if (prefix !== PREFIX || version !== VERSION) return null
  return { domain, action, id }
}

async function replyEphemeral(interaction: Interaction, content: string): Promise<void> {
  if (!('reply' in interaction)) return
  const target = interaction as unknown as {
    replied: boolean; deferred: boolean
    reply: (o: unknown) => Promise<unknown>
    followUp: (o: unknown) => Promise<unknown>
  }
  const payload = { content, ephemeral: true }
  if (target.replied || target.deferred) await target.followUp(payload)
  else await target.reply(payload)
}

/**
 * Point d'entrée unique des composants. Le try/catch global est la garantie
 * qu'aucune interaction ne reste sans réponse : un bouton qui tourne dans le
 * vide est la pire manifestation possible d'un bug côté utilisateur.
 */
export async function dispatchInteraction(interaction: Interaction, deps: BotDeps): Promise<void> {
  if (!('customId' in interaction) || typeof interaction.customId !== 'string') return
  const parsed = parseCustomId(interaction.customId)
  if (!parsed) return // composant d'un autre bot ou format obsolète

  const handler = handlers.get(`${parsed.domain}:${parsed.action}`)
  if (!handler) return

  try {
    await handler({ interaction, id: parsed.id, deps })
  } catch (error) {
    if (error instanceof DomainError) {
      await replyEphemeral(interaction, error.userMessage)
      return
    }
    logger.error({ err: error, customId: interaction.customId }, 'handler en échec')
    await replyEphemeral(interaction, 'Something went wrong. The issue has been logged.')
  }
}
```

- [ ] **Step 5: Implémenter `src/bot/gateway.ts`**

```ts
import { ChannelType, Client, type TextChannel } from 'discord.js'
import type { DiscordGateway, MessagePayload } from '../broadcast/gateway.js'

export class DiscordJsGateway implements DiscordGateway {
  constructor(private readonly client: Client) {}

  private async textChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw Object.assign(new Error('salon introuvable ou non textuel'), { code: 10003 })
    }
    return channel as TextChannel
  }

  async sendMessage(channelId: string, payload: MessagePayload) {
    const channel = await this.textChannel(channelId)
    const message = await channel.send(payload as never)
    return { messageId: message.id }
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload) {
    const channel = await this.textChannel(channelId)
    const message = await channel.messages.fetch(messageId)
    await message.edit(payload as never)
  }

  async sendDM(userId: string, payload: MessagePayload) {
    const user = await this.client.users.fetch(userId)
    const dm = await user.createDM()
    const message = await dm.send(payload as never)
    return { channelId: dm.id, messageId: message.id }
  }

  async createPrivateThread(channelId: string, name: string, inviteUserId: string) {
    const channel = await this.textChannel(channelId)
    const thread = await channel.threads.create({
      name, type: ChannelType.PrivateThread, invitable: false,
    })
    await thread.members.add(inviteUserId)
    return { channelId: thread.id }
  }
}
```

- [ ] **Step 6: Implémenter `src/bot/client.ts`**

```ts
import { Client, GatewayIntentBits, REST, Routes, type SlashCommandBuilder } from 'discord.js'
import { env } from '../config/env.js'
import { logger } from '../logger.js'

export interface CommandModule {
  data: SlashCommandBuilder
  execute: (interaction: never, deps: never) => Promise<void>
}

export function createClient(): Client {
  // Aucun intent privilégié : le bot ne lit jamais le contenu des messages.
  return new Client({ intents: [GatewayIntentBits.Guilds] })
}

export async function registerCommands(commands: CommandModule[]): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env().DISCORD_TOKEN)
  await rest.put(Routes.applicationCommands(env().DISCORD_APP_ID), {
    body: commands.map((c) => c.data.toJSON()),
  })
  logger.info({ count: commands.length }, 'commandes enregistrées')
}
```

- [ ] **Step 7: Vérifier que les tests passent**

Run: `npx vitest run tests/bot/router.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 8: Commit**

```bash
git add src/bot src/logger.ts tests/bot/router.test.ts
git commit -m "feat: routeur d'interactions et implementation discord.js de la passerelle"
```

---

### Task 13: Commandes réseau et configuration de serveur

**Files:**
- Create: `src/commands/network.ts`, `src/commands/set-lfg-channel.ts`, `src/bot/permissions.ts`
- Test: `tests/commands/network.test.ts`

**Interfaces:**
- Consumes: services réseau (Tâche 5), `BotDeps` (Tâche 12)
- Produces:
  - `networkCommand: CommandModule`, `setLfgChannelCommand: CommandModule`
  - `assertOwner(userId: string, ownerId: string): void`
  - `isRecruiter(memberRoleIds: string[], recruiterRoleIds: string[]): boolean`
  - `checkChannelPermissions(channel, botId): string[]` — rend la liste des permissions manquantes

Les tests portent sur les fonctions pures d'autorisation et sur les services appelés, pas sur discord.js : les handlers restent une couche mince que la checklist de fumée manuelle couvre.

- [ ] **Step 1: Écrire le test**

Fichier `tests/commands/network.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { assertOwner, isRecruiter } from '../../src/bot/permissions.js'
import { NotAuthorized } from '../../src/domain/errors.js'
import { createInviteCode, redeemInviteCode, listActiveGuilds, markGuildNeedsAttention } from '../../src/domain/network.js'
import { buildNetworkStatus } from '../../src/commands/network.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

describe('autorisations', () => {
  it('n\'autorise que l\'owner du bot', () => {
    expect(() => assertOwner('u1', 'u1')).not.toThrow()
    expect(() => assertOwner('u2', 'u1')).toThrow(NotAuthorized)
  })

  it('reconnaît un recruteur par l\'un de ses rôles', () => {
    expect(isRecruiter(['a', 'b'], ['b'])).toBe(true)
    expect(isRecruiter(['a'], ['b', 'c'])).toBe(false)
    expect(isRecruiter(['a'], [])).toBe(false) // aucun rôle configuré = personne n'est recruteur
  })
})

describe('/network status', () => {
  it('résume les serveurs actifs, ceux à traiter et les émissions bloquées', async () => {
    const code1 = await createInviteCode(testDb, 'owner')
    const code2 = await createInviteCode(testDb, 'owner')
    const a = await redeemInviteCode(testDb, {
      code: code1, discordGuildId: 'gA', lfgChannelId: 'c', recruiterRoleIds: ['r'], timezone: 'Europe/Paris',
    })
    await redeemInviteCode(testDb, {
      code: code2, discordGuildId: 'gB', lfgChannelId: 'c', recruiterRoleIds: ['r'], timezone: 'Europe/Paris',
    })
    await markGuildNeedsAttention(testDb, a.id, 'missing permissions')

    const status = await buildNetworkStatus(testDb)
    expect(status).toContain('Active partners: 1')
    expect(status).toContain('gA')
    expect(status).toContain('missing permissions')
    expect(await listActiveGuilds(testDb)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/commands/network.test.ts`
Expected: FAIL — modules absents.

- [ ] **Step 3: Implémenter `src/bot/permissions.ts`**

```ts
import { PermissionFlagsBits, type GuildTextBasedChannel } from 'discord.js'
import { NotAuthorized } from '../domain/errors.js'

export function assertOwner(userId: string, ownerId: string): void {
  if (userId !== ownerId) throw new NotAuthorized('this owner-only command')
}

export function isRecruiter(memberRoleIds: string[], recruiterRoleIds: string[]): boolean {
  if (recruiterRoleIds.length === 0) return false
  return memberRoleIds.some((role) => recruiterRoleIds.includes(role))
}

const REQUIRED = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
] as const

/** Détecter le problème à la configuration évite une première diffusion qui échoue en silence. */
export function checkChannelPermissions(channel: GuildTextBasedChannel, botId: string): string[] {
  const perms = channel.permissionsFor(botId)
  if (!perms) return REQUIRED.map(([label]) => label)
  return REQUIRED.filter(([, flag]) => !perms.has(flag)).map(([label]) => label)
}
```

- [ ] **Step 4: Implémenter `src/commands/network.ts`**

```ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import type { Db } from '../db/client.js'
import type { BotDeps } from '../bot/router.js'
import { assertOwner } from '../bot/permissions.js'
import { createInviteCode, revokeInviteCode } from '../domain/network.js'

export async function buildNetworkStatus(db: Db): Promise<string> {
  const [active, attention, blocked] = await Promise.all([
    db.guild.findMany({ where: { status: 'ACTIVE', lfgChannelId: { not: null } } }),
    db.guild.findMany({ where: { status: 'NEEDS_ATTENTION' } }),
    db.eventMessage.count({ where: { disabled: true } }),
  ])
  return [
    `**PugStone network**`,
    `Active partners: ${active.length}`,
    `Needs attention: ${attention.length}`,
    ...attention.map((g) => `  • \`${g.discordGuildId}\` — ${g.statusReason ?? 'unknown reason'}`),
    `Disabled deliveries: ${blocked}`,
  ].join('\n')
}

export const networkCommand = {
  data: new SlashCommandBuilder()
    .setName('network')
    .setDescription('Manage the PugStone partner network (bot owner only)')
    .addSubcommand((s) => s.setName('invite').setDescription('Generate a single-use invite code'))
    .addSubcommand((s) => s.setName('revoke').setDescription('Revoke an unused invite code')
      .addStringOption((o) => o.setName('code').setDescription('Invite code').setRequired(true)))
    .addSubcommand((s) => s.setName('status').setDescription('Show network health')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    assertOwner(interaction.user.id, deps.ownerId)
    await interaction.deferReply({ ephemeral: true })

    switch (interaction.options.getSubcommand()) {
      case 'invite': {
        const code = await createInviteCode(deps.db, interaction.user.id)
        await interaction.editReply(
          `Invite code: \`${code}\`\nThe partner admin runs \`/set-lfg-channel code:${code} channel:#lfg roles:@RaidLead timezone:Europe/Paris\`.`,
        )
        return
      }
      case 'revoke': {
        await revokeInviteCode(deps.db, interaction.options.getString('code', true))
        await interaction.editReply('Code revoked if it was still unused.')
        return
      }
      default:
        await interaction.editReply(await buildNetworkStatus(deps.db))
    }
  },
}
```

- [ ] **Step 5: Implémenter `src/commands/set-lfg-channel.ts`**

```ts
import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction, type GuildTextBasedChannel } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { checkChannelPermissions } from '../bot/permissions.js'
import { redeemInviteCode, updateGuildConfig } from '../domain/network.js'
import { DomainError } from '../domain/errors.js'

export const setLfgChannelCommand = {
  data: new SlashCommandBuilder()
    .setName('set-lfg-channel')
    .setDescription('Join the PugStone network or update this server configuration')
    .setDefaultMemberPermissions(0) // administrateurs uniquement, par défaut Discord
    .addChannelOption((o) => o.setName('channel').setDescription('Channel receiving LFG listings')
      .addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('roles').setDescription('Role allowed to post listings').setRequired(true))
    .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. Europe/Paris').setRequired(true))
    .addStringOption((o) => o.setName('code').setDescription('Invite code (first setup only)')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const channel = interaction.options.getChannel('channel', true) as GuildTextBasedChannel
    const role = interaction.options.getRole('roles', true)
    const timezone = interaction.options.getString('timezone', true)
    const code = interaction.options.getString('code')

    const missing = checkChannelPermissions(channel, interaction.client.user.id)
    if (missing.length > 0) {
      await interaction.editReply(`I am missing these permissions in ${channel}: ${missing.join(', ')}.`)
      return
    }
    if (!Intl.supportedValuesOf('timeZone').includes(timezone)) {
      await interaction.editReply(`\`${timezone}\` is not a valid IANA timezone (e.g. \`Europe/Paris\`).`)
      return
    }

    try {
      if (code) {
        await redeemInviteCode(deps.db, {
          code, discordGuildId: interaction.guildId!, lfgChannelId: channel.id,
          recruiterRoleIds: [role.id], timezone,
        })
        await interaction.editReply(`This server joined the PugStone network. Listings will be posted in ${channel}.`)
      } else {
        await updateGuildConfig(deps.db, {
          discordGuildId: interaction.guildId!, lfgChannelId: channel.id,
          recruiterRoleIds: [role.id], timezone,
        })
        await interaction.editReply('Configuration updated.')
      }
    } catch (error) {
      if (error instanceof DomainError) {
        await interaction.editReply(error.userMessage)
        return
      }
      throw error
    }
  },
}
```

- [ ] **Step 6: Vérifier que les tests passent**

Run: `npx vitest run tests/commands/network.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/commands/network.ts src/commands/set-lfg-channel.ts src/bot/permissions.ts tests/commands/network.test.ts
git commit -m "feat: commandes reseau et configuration du salon LFG"
```

---

### Task 14: Commande /recruit et constructeur de roster

**Files:**
- Create: `src/commands/recruit.ts`, `src/interactions/roster.ts`
- Test: `tests/interactions/roster.test.ts`

**Interfaces:**
- Consumes: `parseRaidTime` (Tâche 6), `createDraft`/`addSlot`/`removeSlot`/`publishEvent` (Tâche 7), `isRecruiter` (Tâche 13), `buildCustomId` (Tâche 8)
- Produces:
  - `recruitCommand: CommandModule`
  - `renderRosterBuilder(view: EventView, selectedClass: string | null): MessagePayload` — fonction pure
  - Handlers enregistrés : `roster:class`, `roster:spec`, `roster:remove`, `roster:publish`

- [ ] **Step 1: Écrire le test du constructeur**

Fichier `tests/interactions/roster.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, loadEventView } from '../../src/domain/events.js'
import { renderRosterBuilder } from '../../src/interactions/roster.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>' }

describe('constructeur de roster', () => {
  it('propose les 13 classes et aucun select de spé tant qu\'aucune classe n\'est choisie', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), null, emojis)
    const rows = payload.components as { components: { custom_id: string; options?: unknown[] }[] }[]
    const classSelect = rows[0]!.components[0]!
    expect(classSelect.custom_id).toBe(`pug:1:roster:class:${draft.id}`)
    expect(classSelect.options).toHaveLength(13)
    expect(rows.some((r) => r.components[0]!.custom_id.includes(':spec:'))).toBe(false)
  })

  it('affiche les spés de la classe choisie', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), 'MAGE', emojis)
    const rows = payload.components as { components: { custom_id: string; options?: { value: string }[] }[] }[]
    const specSelect = rows.find((r) => r.components[0]!.custom_id.includes(':spec:'))!.components[0]!
    expect(specSelect.options!.map((o) => o.value)).toEqual(['ARCANE', 'FIRE', 'FROST'])
  })

  it('liste les places ajoutées et active la publication', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), null, emojis)
    expect((payload.embeds[0] as { description: string }).description).toContain('Arcane')
    const publish = (payload.components as { components: { custom_id: string; disabled?: boolean }[] }[])
      .flatMap((r) => r.components).find((c) => c.custom_id.includes(':publish:'))!
    expect(publish.disabled).toBe(false)
  })

  it('désactive la publication tant que le roster est vide', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    const payload = renderRosterBuilder(await loadEventView(testDb, draft.id), null, emojis)
    const publish = (payload.components as { components: { custom_id: string; disabled?: boolean }[] }[])
      .flatMap((r) => r.components).find((c) => c.custom_id.includes(':publish:'))!
    expect(publish.disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/interactions/roster.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/interactions/roster.ts`**

```ts
import type { EventView } from '../domain/events.js'
import type { MessagePayload } from '../broadcast/gateway.js'
import { buildCustomId } from '../broadcast/render.js'
import { WOW_CLASSES, findClass, findSpec } from '../config/wow.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { registerHandler, type HandlerContext } from '../bot/router.js'
import { addSlot, loadEventView, publishEvent, removeSlot } from '../domain/events.js'

/**
 * Le brouillon vit en base, pas en mémoire : le constructeur se ré-affiche à
 * l'identique après un redémarrage du bot ou un rechargement du client Discord.
 */
export function renderRosterBuilder(view: EventView, selectedClass: string | null, emojis: EmojiMap): MessagePayload {
  const { event, slots } = view
  const rows: unknown[] = [{
    type: 1,
    components: [{
      type: 3,
      custom_id: buildCustomId('roster', 'class', event.id),
      placeholder: 'Pick a class',
      options: WOW_CLASSES.map((c) => ({ label: c.label, value: c.name, default: c.name === selectedClass })),
    }],
  }]

  const cls = selectedClass ? findClass(selectedClass) : undefined
  if (cls) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: buildCustomId('roster', 'spec', `${event.id}|${cls.name}`.slice(0, 80)),
        placeholder: `Add a ${cls.label} spot`,
        options: cls.specs.map((s) => ({ label: s.label, value: s.name, description: s.role })),
      }],
    })
  }

  if (slots.length > 0) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: buildCustomId('roster', 'remove', event.id),
        placeholder: 'Remove a spot',
        options: slots.slice(0, 25).map((s) => ({
          label: `${findSpec(s.className, s.specName)?.label ?? s.specName} (${s.className})`,
          value: s.id,
        })),
      }],
    })
  }

  rows.push({
    type: 1,
    components: [{
      type: 2, style: 3, label: 'Publish LFG',
      custom_id: buildCustomId('roster', 'publish', event.id),
      disabled: slots.length === 0,
    }],
  })

  return {
    embeds: [{
      title: `Draft — ${event.raidName} (${event.difficulty})`,
      description: slots.length === 0
        ? '_No spots yet. Pick a class, then a specialization._'
        : slots.map((s) => `🔸 ${classEmoji(emojis, s.className)} ${findSpec(s.className, s.specName)?.label ?? s.specName}`).join('\n'),
      color: 0x5865f2,
    }],
    components: rows,
  }
}

async function refresh(ctx: HandlerContext, eventId: string, selectedClass: string | null): Promise<void> {
  const view = await loadEventView(ctx.deps.db, eventId)
  const payload = renderRosterBuilder(view, selectedClass, ctx.deps.emojis)
  await (ctx.interaction as unknown as { update: (o: unknown) => Promise<unknown> }).update(payload)
}

export function registerRosterHandlers(): void {
  registerHandler('roster', 'class', async (ctx) => {
    const value = (ctx.interaction as unknown as { values: string[] }).values[0]!
    await refresh(ctx, ctx.id, value)
  })

  registerHandler('roster', 'spec', async (ctx) => {
    const [eventId, className] = ctx.id.split('|') as [string, string]
    const specName = (ctx.interaction as unknown as { values: string[] }).values[0]!
    await addSlot(ctx.deps.db, eventId, { className, specName })
    await refresh(ctx, eventId, className)
  })

  registerHandler('roster', 'remove', async (ctx) => {
    const slotId = (ctx.interaction as unknown as { values: string[] }).values[0]!
    await removeSlot(ctx.deps.db, slotId)
    await refresh(ctx, ctx.id, null)
  })

  registerHandler('roster', 'publish', async (ctx) => {
    const { targets } = await publishEvent(ctx.deps.db, ctx.id)
    await (ctx.interaction as unknown as { update: (o: unknown) => Promise<unknown> }).update({
      content: `Listing published to ${targets} server(s). Your dashboard is on its way by DM.`,
      embeds: [], components: [],
    })
  })
}
```

- [ ] **Step 4: Implémenter `src/commands/recruit.ts`**

```ts
import { SlashCommandBuilder, type ChatInputCommandInteraction, type GuildMember } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { isRecruiter } from '../bot/permissions.js'
import { createDraft, loadEventView } from '../domain/events.js'
import { parseRaidTime } from '../domain/time.js'
import { renderRosterBuilder } from '../interactions/roster.js'
import { DomainError } from '../domain/errors.js'

export const recruitCommand = {
  data: new SlashCommandBuilder()
    .setName('recruit')
    .setDescription('Create a cross-server LFG listing')
    .addStringOption((o) => o.setName('raid').setDescription('Raid name').setRequired(true))
    .addStringOption((o) => o.setName('difficulty').setDescription('Difficulty').setRequired(true)
      .addChoices({ name: 'Normal', value: 'NORMAL' }, { name: 'Heroic', value: 'HEROIC' }, { name: 'Mythic', value: 'MYTHIC' }))
    .addStringOption((o) => o.setName('time').setDescription('HH:MM or DD/MM HH:MM').setRequired(true))
    .addStringOption((o) => o.setName('contact').setDescription('Battle.net or in-game name').setRequired(true)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const guild = await deps.db.guild.findUnique({ where: { discordGuildId: interaction.guildId! } })
    if (!guild) {
      await interaction.editReply('This server is not part of the PugStone network yet.')
      return
    }

    const member = interaction.member as GuildMember
    if (!isRecruiter([...member.roles.cache.keys()], guild.recruiterRoleIds)) {
      await interaction.editReply('You do not have the role required to post listings on this server.')
      return
    }

    try {
      const scheduledAt = parseRaidTime(interaction.options.getString('time', true), guild.timezone, new Date())
      const draft = await createDraft(deps.db, {
        originGuildId: guild.id,
        authorId: interaction.user.id,
        raidName: interaction.options.getString('raid', true),
        difficulty: interaction.options.getString('difficulty', true) as 'NORMAL' | 'HEROIC' | 'MYTHIC',
        scheduledAt,
      })
      await deps.db.event.update({
        where: { id: draft.id },
        data: { authorContact: interaction.options.getString('contact', true) },
      })
      const view = await loadEventView(deps.db, draft.id)
      await interaction.editReply(renderRosterBuilder(view, null, deps.emojis) as never)
    } catch (error) {
      if (error instanceof DomainError) {
        await interaction.editReply(error.userMessage)
        return
      }
      throw error
    }
  },
}
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npx vitest run tests/interactions/roster.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/commands/recruit.ts src/interactions/roster.ts tests/interactions/roster.test.ts
git commit -m "feat: commande recruit et constructeur de roster persistant"
```

---

### Task 15: Parcours de candidature

**Files:**
- Create: `src/interactions/apply.ts`
- Test: `tests/interactions/apply.test.ts`

**Interfaces:**
- Consumes: `openSlots`, `validateApplicationInput`, `submitApplication` (Tâche 10), `buildCustomId` (Tâche 8), routeur (Tâche 12)
- Produces:
  - `buildApplyModal(slotId: string, specLabel: string): unknown` — structure de modal Discord
  - `buildRoleSelect(eventId: string, slots: Slot[], emojis: EmojiMap): MessagePayload`
  - `readModalFields(fields: { getTextInputValue(id: string): string }): { ignRealm; itemLevel; logsUrl; comment }`
  - Handlers : `app:open`, `app:role`, `app:submit`

Rappel de la contrainte Discord : un modal doit être la **première** réponse à une interaction. Le handler `app:open` ne fait donc aucun `deferReply` — il lit l'état puis ouvre soit le modal, soit le select.

- [ ] **Step 1: Écrire le test**

Fichier `tests/interactions/apply.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb, resetDb } from '../helpers/db.js'
import { makeGuild, makeDraft } from '../helpers/factories.js'
import { addSlot, publishEvent } from '../../src/domain/events.js'
import { openSlots } from '../../src/domain/applications.js'
import { buildApplyModal, buildRoleSelect, readModalFields } from '../../src/interactions/apply.js'

beforeEach(resetDb)
afterAll(() => testDb.$disconnect())

const emojis = { MAGE: '<:mage:1>', PALADIN: '<:pala:2>' }

describe('modal de candidature', () => {
  it('contient les quatre champs attendus, dont un seul optionnel', () => {
    const modal = buildApplyModal('s1', 'Arcane') as {
      custom_id: string
      components: { components: { custom_id: string; required: boolean; style: number }[] }[]
    }
    expect(modal.custom_id).toBe('pug:1:app:submit:s1')
    const fields = modal.components.map((row) => row.components[0]!)
    expect(fields.map((f) => f.custom_id)).toEqual(['ignRealm', 'itemLevel', 'logsUrl', 'comment'])
    expect(fields.filter((f) => f.required)).toHaveLength(3)
    expect(fields[3]!.style).toBe(2) // paragraphe
  })
})

describe('choix du rôle', () => {
  it('propose une option par place ouverte, avec le nom de la classe', async () => {
    const guild = await makeGuild(testDb)
    const draft = await makeDraft(testDb, guild.id)
    await addSlot(testDb, draft.id, { className: 'MAGE', specName: 'ARCANE' })
    await addSlot(testDb, draft.id, { className: 'PALADIN', specName: 'PROTECTION' })
    await publishEvent(testDb, draft.id)

    const payload = buildRoleSelect(draft.id, await openSlots(testDb, draft.id), emojis)
    const select = (payload.components[0] as { components: { custom_id: string; options: { label: string }[] }[] }).components[0]!
    expect(select.custom_id).toBe(`pug:1:app:role:${draft.id}`)
    expect(select.options.map((o) => o.label)).toEqual(['Arcane (Mage)', 'Protection (Paladin)'])
  })
})

describe('lecture du modal', () => {
  it('extrait les champs et laisse le commentaire vide devenir null', () => {
    const fields = {
      getTextInputValue: (id: string) => ({ ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://warcraftlogs.com/x', comment: '  ' }[id] ?? ''),
    }
    expect(readModalFields(fields)).toEqual({
      ignRealm: 'Pug-Hyjal', itemLevel: '626', logsUrl: 'https://warcraftlogs.com/x', comment: null,
    })
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/interactions/apply.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/interactions/apply.ts`**

```ts
import type { Slot } from '@prisma/client'
import type { MessagePayload } from '../broadcast/gateway.js'
import { buildCustomId } from '../broadcast/render.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { findClass, findSpec } from '../config/wow.js'
import { registerHandler } from '../bot/router.js'
import { openSlots, submitApplication, validateApplicationInput } from '../domain/applications.js'
import { EventClosed } from '../domain/errors.js'

export function buildApplyModal(slotId: string, specLabel: string): unknown {
  const input = (id: string, label: string, style: 1 | 2, required: boolean, placeholder?: string) => ({
    type: 1,
    components: [{ type: 4, custom_id: id, label, style, required, max_length: style === 2 ? 300 : 100, placeholder }],
  })
  return {
    custom_id: buildCustomId('app', 'submit', slotId),
    title: `Apply — ${specLabel}`.slice(0, 45),
    components: [
      input('ignRealm', 'In-game Name & Realm', 1, true, 'Pug-Hyjal'),
      input('itemLevel', 'Item Level (iLvl)', 1, true, '626'),
      input('logsUrl', 'WarcraftLogs Link', 1, true, 'https://www.warcraftlogs.com/character/...'),
      input('comment', 'Comments for RL', 2, false),
    ],
  }
}

function slotLabel(slot: Slot): string {
  const spec = findSpec(slot.className, slot.specName)?.label ?? slot.specName
  const cls = findClass(slot.className)?.label ?? slot.className
  return `${spec} (${cls})`
}

export function buildRoleSelect(eventId: string, slots: Slot[], emojis: EmojiMap): MessagePayload {
  return {
    content: 'Which role are you applying for?',
    embeds: [],
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: buildCustomId('app', 'role', eventId),
        placeholder: 'Pick a spot',
        options: slots.slice(0, 25).map((slot) => ({
          label: slotLabel(slot),
          value: slot.id,
          description: `${classEmoji(emojis, slot.className)} ${slot.role}`.slice(0, 100),
        })),
      }],
    }],
  }
}

export function readModalFields(fields: { getTextInputValue(id: string): string }) {
  const comment = fields.getTextInputValue('comment').trim()
  return {
    ignRealm: fields.getTextInputValue('ignRealm'),
    itemLevel: fields.getTextInputValue('itemLevel'),
    logsUrl: fields.getTextInputValue('logsUrl'),
    comment: comment.length > 0 ? comment : null,
  }
}

export function registerApplyHandlers(): void {
  // Aucun deferReply ici : Discord exige que le modal soit la première réponse.
  registerHandler('app', 'open', async (ctx) => {
    const slots = await openSlots(ctx.deps.db, ctx.id)
    const event = await ctx.deps.db.event.findUniqueOrThrow({ where: { id: ctx.id } })
    if (event.status !== 'PUBLISHED' || slots.length === 0) throw new EventClosed()

    const interaction = ctx.interaction as unknown as {
      showModal: (m: unknown) => Promise<void>
      reply: (o: unknown) => Promise<void>
    }
    if (slots.length === 1) {
      const slot = slots[0]!
      await interaction.showModal(buildApplyModal(slot.id, findSpec(slot.className, slot.specName)?.label ?? slot.specName))
      return
    }
    await interaction.reply({ ...buildRoleSelect(ctx.id, slots, ctx.deps.emojis), ephemeral: true })
  })

  registerHandler('app', 'role', async (ctx) => {
    const slotId = (ctx.interaction as unknown as { values: string[] }).values[0]!
    const slot = await ctx.deps.db.slot.findUniqueOrThrow({ where: { id: slotId } })
    await (ctx.interaction as unknown as { showModal: (m: unknown) => Promise<void> }).showModal(
      buildApplyModal(slot.id, findSpec(slot.className, slot.specName)?.label ?? slot.specName),
    )
  })

  registerHandler('app', 'submit', async (ctx) => {
    const interaction = ctx.interaction as unknown as {
      fields: { getTextInputValue(id: string): string }
      user: { id: string; username: string }
      reply: (o: unknown) => Promise<void>
    }
    const validation = validateApplicationInput(readModalFields(interaction.fields))
    if (!validation.ok) {
      // Discord perd la saisie : le message doit lister tous les problèmes d'un coup.
      await interaction.reply({
        content: ['Your application was not submitted:', ...validation.errors.map((e) => `• ${e}`)].join('\n'),
        ephemeral: true,
      })
      return
    }

    await submitApplication(ctx.deps.db, {
      slotId: ctx.id,
      applicantId: interaction.user.id,
      applicantTag: interaction.user.username,
      ...validation.value,
    })
    await interaction.reply({
      content: 'Application sent. The raid leader will contact you if you are picked.',
      ephemeral: true,
    })
  })
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `npx vitest run tests/interactions/apply.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/interactions/apply.ts tests/interactions/apply.test.ts
git commit -m "feat: parcours de candidature avec selection de role et modal"
```

---

### Task 16: Décision du Raid Leader

**Files:**
- Create: `src/interactions/dashboard.ts`, `src/commands/cancel.ts`
- Test: `tests/interactions/dashboard.test.ts`

**Interfaces:**
- Consumes: `acceptApplication`, `cancelEvent`, `DiscordGateway`, routeur
- Produces:
  - `notifyAccepted(gateway, { applicantId, contact, raidName }): Promise<{ delivered: boolean }>`
  - Handlers : `dash:accept`, `dash:close`
  - `cancelCommand: CommandModule`

- [ ] **Step 1: Écrire le test**

Fichier `tests/interactions/dashboard.test.ts` :

```ts
import { describe, it, expect } from 'vitest'
import { FakeGateway, discordError } from '../helpers/fake-gateway.js'
import { notifyAccepted } from '../../src/interactions/dashboard.js'

const accepted = { applicantId: 'p1', contact: 'RaidLead#1234', raidName: 'Nerub-ar Palace' }

describe('notification du candidat retenu', () => {
  it('envoie un DM contenant le raid et le contact du RL', async () => {
    const gateway = new FakeGateway()
    const result = await notifyAccepted(gateway, accepted)
    expect(result.delivered).toBe(true)
    expect(gateway.dms[0]!.payload.content).toContain('Nerub-ar Palace')
    expect(gateway.dms[0]!.payload.content).toContain('RaidLead#1234')
  })

  it('signale l\'échec sans lever quand le joueur a fermé ses DM', async () => {
    const gateway = new FakeGateway()
    gateway.failAlways(discordError(50007))
    const result = await notifyAccepted(gateway, accepted)
    expect(result.delivered).toBe(false)
  })
})
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/interactions/dashboard.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter `src/interactions/dashboard.ts`**

```ts
import type { DiscordGateway } from '../broadcast/gateway.js'
import { registerHandler } from '../bot/router.js'
import { acceptApplication } from '../domain/applications.js'
import { cancelEvent } from '../domain/events.js'
import { logger } from '../logger.js'

export interface AcceptedNotice {
  applicantId: string
  contact: string
  raidName: string
}

/**
 * Un DM refusé ne doit jamais faire échouer l'acceptation : la place est déjà
 * attribuée en base. On rend l'information au RL pour qu'il prenne le relais.
 */
export async function notifyAccepted(gateway: DiscordGateway, notice: AcceptedNotice): Promise<{ delivered: boolean }> {
  try {
    await gateway.sendDM(notice.applicantId, {
      content: `You have been accepted for **${notice.raidName}**. Whisper \`${notice.contact}\` for the invite.`,
      embeds: [], components: [],
    })
    return { delivered: true }
  } catch (error) {
    logger.warn({ err: error, applicantId: notice.applicantId }, 'DM au candidat retenu impossible')
    return { delivered: false }
  }
}

export function registerDashboardHandlers(): void {
  registerHandler('dash', 'accept', async (ctx) => {
    const applicationId = (ctx.interaction as unknown as { values: string[] }).values[0]!
    const interaction = ctx.interaction as unknown as {
      user: { id: string }
      deferReply: (o: unknown) => Promise<void>
      editReply: (o: unknown) => Promise<void>
    }
    await interaction.deferReply({ ephemeral: true })

    const result = await acceptApplication(ctx.deps.db, { applicationId, actorId: interaction.user.id })
    const { delivered } = await notifyAccepted(ctx.deps.gateway, result)

    await interaction.editReply({
      content: delivered
        ? `Player accepted and notified.${result.eventCompleted ? ' All spots are filled — the listing is now closed.' : ''}`
        : `Player accepted, but I could not DM them (their DMs are closed). Please contact <@${result.applicantId}> directly.`,
    })
    // Le dashboard et les embeds publics se mettront à jour au prochain tick du worker.
  })

  registerHandler('dash', 'close', async (ctx) => {
    const interaction = ctx.interaction as unknown as {
      user: { id: string }
      deferReply: (o: unknown) => Promise<void>
      editReply: (o: unknown) => Promise<void>
    }
    await interaction.deferReply({ ephemeral: true })
    await cancelEvent(ctx.deps.db, ctx.id, interaction.user.id)
    await interaction.editReply({ content: 'Listing closed. The network will be updated shortly.' })
  })
}
```

- [ ] **Step 4: Implémenter `src/commands/cancel.ts`**

```ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { cancelEvent } from '../domain/events.js'
import { DomainError } from '../domain/errors.js'

export const cancelCommand = {
  data: new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel one of your active listings')
    .addStringOption((o) => o.setName('listing').setDescription('Listing to cancel').setRequired(true).setAutocomplete(true)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    try {
      await cancelEvent(deps.db, interaction.options.getString('listing', true), interaction.user.id)
      await interaction.editReply('Listing cancelled. The network will be updated shortly.')
    } catch (error) {
      if (error instanceof DomainError) {
        await interaction.editReply(error.userMessage)
        return
      }
      throw error
    }
  },

  /** Autocomplétion : uniquement les annonces publiées dont l'auteur est l'appelant. */
  async autocomplete(interaction: { user: { id: string }; respond: (o: unknown[]) => Promise<void> }, deps: BotDeps): Promise<void> {
    const events = await deps.db.event.findMany({
      where: { authorId: interaction.user.id, status: 'PUBLISHED' },
      orderBy: { scheduledAt: 'asc' },
      take: 25,
    })
    await interaction.respond(events.map((e) => ({ name: `${e.raidName} (${e.difficulty})`.slice(0, 100), value: e.id })))
  },
}
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npx vitest run tests/interactions/dashboard.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/interactions/dashboard.ts src/commands/cancel.ts tests/interactions/dashboard.test.ts
git commit -m "feat: acceptation, cloture et notification du candidat retenu"
```

---

### Task 17: Assemblage, déploiement et intégration continue

**Files:**
- Create: `src/index.ts`, `Dockerfile`, `.github/workflows/ci.yml`, `README.md`, `docs/smoke-checklist.md`
- Modify: `docker-compose.yml` (ajout du service `bot`), `package.json` (scripts)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: tout ce qui précède
- Produits: `startLoop(name, intervalMs, task, now): { stop: () => void }`, binaire `node dist/index.js`

- [ ] **Step 1: Écrire le test de la boucle**

Le seul comportement d'assemblage qui mérite un test automatisé est la boucle périodique : elle doit survivre à une itération en échec, sinon une erreur passagère arrête définitivement l'expiration ou l'émission.

Fichier `tests/index.test.ts` :

```ts
import { describe, it, expect, vi } from 'vitest'
import { startLoop } from '../src/index.js'

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
```

- [ ] **Step 2: Lancer le test et vérifier l'échec**

Run: `npx vitest run tests/index.test.ts`
Expected: FAIL — `startLoop` n'existe pas.

- [ ] **Step 3: Implémenter `src/index.ts`**

```ts
import { Events } from 'discord.js'
import { readFileSync } from 'node:fs'
import { env } from './config/env.js'
import { loadEmojiMap } from './config/emojis.js'
import { prisma } from './db/client.js'
import { logger } from './logger.js'
import { createClient, registerCommands, type CommandModule } from './bot/client.js'
import { DiscordJsGateway } from './bot/gateway.js'
import { dispatchInteraction, type BotDeps } from './bot/router.js'
import { registerRosterHandlers } from './interactions/roster.js'
import { registerApplyHandlers } from './interactions/apply.js'
import { registerDashboardHandlers } from './interactions/dashboard.js'
import { runOutboxTick } from './broadcast/outbox.js'
import { expireDueEvents } from './scheduler/expiration.js'
import { purgeOldEvents } from './scheduler/retention.js'
import { suspendGuild } from './domain/network.js'
import { networkCommand } from './commands/network.js'
import { setLfgChannelCommand } from './commands/set-lfg-channel.js'
import { recruitCommand } from './commands/recruit.js'
import { cancelCommand } from './commands/cancel.js'
import { DomainError } from './domain/errors.js'

export interface Loop { stop: () => void }

/** Une itération en échec ne doit jamais arrêter la boucle : on journalise et on continue. */
export function startLoop(name: string, intervalMs: number, task: () => Promise<unknown>): Loop {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void task().catch((error) => logger.error({ err: error, loop: name }, 'itération en échec'))
  }, intervalMs)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

async function main(): Promise<void> {
  const commands: CommandModule[] = [networkCommand, setLfgChannelCommand, recruitCommand, cancelCommand] as never
  const client = createClient()
  const deps: BotDeps = {
    db: prisma,
    gateway: new DiscordJsGateway(client),
    emojis: loadEmojiMap(JSON.parse(readFileSync('config/emojis.json', 'utf8'))),
    ownerId: env().OWNER_DISCORD_ID,
  }

  registerRosterHandlers()
  registerApplyHandlers()
  registerDashboardHandlers()

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'cancel') await cancelCommand.autocomplete(interaction as never, deps)
      return
    }
    if (interaction.isChatInputCommand()) {
      const command = commands.find((c) => c.data.name === interaction.commandName)
      if (!command) return
      try {
        await command.execute(interaction as never, deps as never)
      } catch (error) {
        const content = error instanceof DomainError ? error.userMessage : 'Something went wrong. The issue has been logged.'
        if (!(error instanceof DomainError)) logger.error({ err: error, command: interaction.commandName }, 'commande en échec')
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content })
        else await interaction.reply({ content, ephemeral: true })
      }
      return
    }
    await dispatchInteraction(interaction, deps)
  })

  // Expulsion du bot : le serveur sort du réseau et ses émissions cessent immédiatement.
  client.on(Events.GuildDelete, async (guild) => {
    await suspendGuild(prisma, guild.id)
    logger.warn({ guildId: guild.id }, 'bot retiré d\'un serveur partenaire')
  })

  await registerCommands(commands)
  await client.login(env().DISCORD_TOKEN)
  logger.info('client Discord connecté')

  const loops = [
    startLoop('outbox', 3_000, () => runOutboxTick({ db: prisma, gateway: deps.gateway, emojis: deps.emojis, now: () => new Date() })),
    startLoop('expiration', 60_000, () => expireDueEvents(prisma, new Date())),
    startLoop('retention', 24 * 60 * 60 * 1000, () => purgeOldEvents(prisma, new Date())),
  ]

  const shutdown = async () => {
    logger.info('arrêt demandé')
    loops.forEach((loop) => loop.stop())
    await client.destroy()
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Ne démarre pas quand le module est importé par les tests.
if (process.env.NODE_ENV !== 'test' && process.argv[1]?.includes('index')) {
  void main().catch((error) => {
    logger.fatal({ err: error }, 'démarrage impossible')
    process.exit(1)
  })
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `npx vitest run tests/index.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Ajouter les scripts npm**

```bash
npm pkg set scripts.dev="tsx watch src/index.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/src/index.js"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.migrate="prisma migrate deploy"
```

- [ ] **Step 6: Créer le `Dockerfile` et compléter `docker-compose.yml`**

`Dockerfile` :

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY config ./config
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
```

Ajouter dans `docker-compose.yml` :

```yaml
  bot:
    build: .
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      DATABASE_URL: postgresql://pugstone:pugstone@postgres:5432/pugstone
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      DISCORD_APP_ID: ${DISCORD_APP_ID}
      OWNER_DISCORD_ID: ${OWNER_DISCORD_ID}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    restart: unless-stopped
```

- [ ] **Step 7: Créer `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [develop, main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: pugstone
          POSTGRES_PASSWORD: pugstone
          POSTGRES_DB: pugstone_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql://pugstone:pugstone@localhost:5432/pugstone_test
      TEST_DATABASE_URL: postgresql://pugstone:pugstone@localhost:5432/pugstone_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npx prisma migrate deploy
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 8: Écrire `docs/smoke-checklist.md`**

L'API Discord n'est pas testée automatiquement : cette checklist est la contrepartie, à rejouer avant chaque mise en production sur deux serveurs de test (un émetteur, un récepteur).

```markdown
# Checklist de fumée — à rejouer avant chaque mise en production

Prérequis : deux serveurs de test (`ÉMETTEUR`, `RÉCEPTEUR`), le bot invité sur les deux.

1. `/network invite` sur ÉMETTEUR (compte owner) → un code est renvoyé en éphémère.
2. `/set-lfg-channel` avec ce code sur ÉMETTEUR → confirmation d'entrée dans le réseau.
3. Répéter 1-2 sur RÉCEPTEUR avec un second code.
4. Retirer au bot la permission « Envoyer des messages » sur le salon LFG de RÉCEPTEUR, puis `/set-lfg-channel` → le bot annonce la permission manquante. Rétablir.
5. `/recruit` sur ÉMETTEUR avec un membre **sans** le rôle recruteur → refus explicite.
6. `/recruit` avec le rôle recruteur → le constructeur de roster s'affiche en éphémère.
7. Ajouter deux places (dont deux fois la même spé), en retirer une, redémarrer le bot, rouvrir le message → l'état du brouillon est conservé.
8. `[Publish LFG]` → l'annonce apparaît sur les deux serveurs, le dashboard arrive en DM.
9. Fermer ses DM et republier une annonce → le dashboard bascule sur un thread privé.
10. Cliquer `[⚔️ Apply]` avec une seule place ouverte → le modal s'ouvre directement.
11. Soumettre un iLvl non numérique et un lien hors warcraftlogs → les deux erreurs sont listées ensemble.
12. Soumettre une candidature valide → confirmation, et le dashboard se met à jour en quelques secondes.
13. Avec deux places ouvertes, cliquer `[⚔️ Apply]` → le select de rôle précède le modal.
14. Accepter un candidat → DM reçu par le joueur, place `✅ Filled` sur **les deux** serveurs.
15. Accepter la dernière place → titre `[COMPLETED]` et bouton `Apply` désactivé partout.
16. Supprimer manuellement le message public sur RÉCEPTEUR puis provoquer une mise à jour → aucune republication, aucune boucle d'erreur dans les logs.
17. Expulser le bot de RÉCEPTEUR → `/network status` le montre suspendu, plus aucune émission vers lui.
18. Créer une annonce à une heure déjà dépassée dans la minute → passage automatique en `[EXPIRED]`.
```

- [ ] **Step 9: Écrire le `README.md`**

Contenu minimal : présentation du bot, prérequis (Node 22, Docker), création de l'application Discord et permissions nécessaires (`applications.commands`, `bot` avec `Send Messages`, `Embed Links`, `Create Private Threads`), téléversement des Application Emojis et report des identifiants dans `config/emojis.json`, démarrage local (`docker compose up -d postgres`, `npm run migrate`, `npm run dev`), lancement des tests, et procédure de déploiement (`docker compose up -d --build`).

- [ ] **Step 10: Lancer la suite complète**

Run: `npm run typecheck && npm test`
Expected: PASS sur l'ensemble des fichiers de test, sans test ignoré.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts Dockerfile docker-compose.yml package.json .github README.md docs/smoke-checklist.md tests/index.test.ts
git commit -m "feat: assemblage du bot, conteneurisation et integration continue"
```

---

## Auto-revue du plan

**Couverture de la spec.** Chaque section a sa tâche : §2 décisions → Tâches 1-2 ; §3 architecture et frontière Discord → Tâches 4, 12 ; §4 modèle de données → Tâche 2 ; §5.1 admission → Tâches 5, 13 ; §5.2 création → Tâches 6, 7, 14 ; §5.3 embed public → Tâche 8 ; §5.4 candidature → Tâches 10, 15 ; §5.5 dashboard → Tâches 8, 9 (bascule thread), 16 ; §5.6 acceptation → Tâches 10, 16 ; §5.7 clôture → Tâches 7, 11, 16 ; §6 erreurs et concurrence → Tâches 4, 9, 10, 12 ; §7 tests → réparti sur toutes les tâches, plus CI en Tâche 17.

**Deux écarts assumés par rapport à la spec**, tous deux justifiés en tête de document : la couche `repositories` est abandonnée (YAGNI, Prisma est déjà l'abstraction), et l'isolation des tests se fait par `TRUNCATE` plutôt que par rollback de transaction (les tests de concurrence exigent des connexions distinctes).

**Cohérence des types.** `Db` (Tâche 2) est le premier paramètre de tous les services. `EventView` (Tâche 7) est consommé à l'identique par `render.ts` (Tâche 8) et `outbox.ts` (Tâche 9). `MessagePayload` (Tâche 4) est le type de retour de toutes les fonctions de rendu. `buildCustomId` est défini une seule fois (Tâche 8) et `parseCustomId` (Tâche 12) en est l'exact inverse — vérifié par un test.

**Point de vigilance pour l'exécutant.** Les deux tests de concurrence de la Tâche 10 sont le cœur de la correction du produit. S'ils échouent par intermittence, le verrou est mal posé : corriger le verrou, jamais l'assertion.

