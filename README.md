# PugStone

Bot Discord de LFG (Looking For Group) inter-serveurs pour World of Warcraft.
Un Raid Leader publie une annonce de recrutement sur son serveur via
`/recruit` ; PugStone la diffuse automatiquement sur tous les serveurs
partenaires du réseau, centralise les candidatures et tient à jour un
dashboard privé pendant toute la vie de l'annonce (brouillon, publication,
acceptations, complétion ou expiration).

## Prérequis

- [Node.js 22](https://nodejs.org/) (correspond à l'image `node:22-alpine`
  utilisée par le `Dockerfile`).
- [Docker](https://www.docker.com/) et Docker Compose, pour la base Postgres
  locale et/ou le déploiement conteneurisé.
- Une application Discord (voir ci-dessous).

## Créer l'application Discord

1. Créer une application sur le
   [portail développeur Discord](https://discord.com/developers/applications).
2. Onglet **Bot** : créer le bot, copier son jeton (`DISCORD_TOKEN`) et
   l'identifiant de l'application (`DISCORD_APP_ID`, visible sur la page
   **General Information**).
3. Onglet **Installation** : générer un lien d'invitation avec les scopes
   `applications.commands` et `bot`, et les permissions bot suivantes :
   - `View Channel`
   - `Send Messages`
   - `Embed Links`
   - `Create Private Threads`

   `View Channel`, `Send Messages` et `Embed Links` sont exigées sur le salon
   LFG lui-même : `/set-lfg-channel` les vérifie et refuse la configuration en
   nommant celles qui manquent. `Create Private Threads` ne sert que de repli,
   quand un Raid Leader a fermé ses messages privés.
4. Inviter le bot sur chaque serveur partenaire avec ce lien.
5. `OWNER_DISCORD_ID` est l'identifiant Discord (pas le pseudo) du compte
   autorisé à exécuter `/network` — en général l'exploitant du bot.

### Application Emojis

Les icônes de classe WoW (`src/config/wow.ts`) sont rendues via les
[Application Emojis](https://discord.com/developers/docs/resources/emoji#emoji-object)
de l'application, téléversés une fois pour toutes dans l'onglet **Emojis**
du portail développeur (un emoji par classe, ex. `death_knight`,
`demon_hunter`, ...). Reporter ensuite chaque identifiant obtenu dans
`config/emojis.json`, sous la forme d'un objet plat `NOM_DE_CLASSE ->
balisage emoji` :

```json
{
  "DEATH_KNIGHT": "<:death_knight:1234567890123456789>",
  "DEMON_HUNTER": "<:demon_hunter:1234567890123456789>"
}
```

Une classe absente de ce fichier se replie silencieusement sur un symbole
générique (`•`) — un emoji mal configuré ne doit jamais empêcher le bot de
démarrer.

## Démarrage local

```bash
cp .env.example .env       # puis renseigner DISCORD_TOKEN, DISCORD_APP_ID, OWNER_DISCORD_ID
docker compose up -d postgres
npm ci
npm run migrate
npm run dev
```

`docker compose up -d postgres` publie Postgres sur le port **5433** de
l'hôte (un Postgres natif occupe couramment le 5432 en développement) ; à
l'intérieur du réseau Docker (service `bot`), la base reste jointe sur le
port interne 5432 — voir `docker-compose.yml`. `.env` (git-ignoré) pointe
donc sur `localhost:5433`, alors que le `DATABASE_URL` du service `bot`
pointe sur `postgres:5432`.

`npm run dev` démarre le bot avec rechargement à chaud (`tsx watch`) ; il ne
fait rien s'il est importé par les tests (`src/index.ts`).

Le fichier `.env` est chargé explicitement (`dotenv`) par le point d'entrée du
bot **et** par `prisma.config.ts` : Prisma 7 ne le lit plus automatiquement, et
sans cela `npm run migrate` échouerait à résoudre `DATABASE_URL` alors même que
le fichier existe. En conteneur, les variables viennent de l'environnement et
l'absence de fichier `.env` est sans conséquence.

## Tests

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://pugstone:pugstone@localhost:5433/pugstone_test npm test
```

`TEST_DATABASE_URL` doit pointer vers une base dédiée, distincte de la base
applicative : chaque test la vide par `TRUNCATE` (`tests/helpers/db.ts`).
`npm run typecheck` vérifie le typage strict sans émettre de fichiers.

## Déploiement

```bash
cp .env.example .env       # renseigner DISCORD_TOKEN, DISCORD_APP_ID, OWNER_DISCORD_ID
docker compose up -d --build
```

Le service `bot` attend que `postgres` soit en bonne santé, applique les
migrations au démarrage (`npx prisma migrate deploy`), puis lance le
processus. Avant toute mise en production, rejouer la
[checklist de fumée](docs/smoke-checklist.md) : l'API Discord réelle n'est
pas couverte par les tests automatisés.

## Intégration continue

`.github/workflows/ci.yml` exécute, sur chaque push vers `develop`/`main`
et chaque pull request, avec un service Postgres éphémère : installation
des dépendances, génération du client Prisma, application des migrations,
vérification des types (`npm run typecheck`) puis suite de tests
(`npm test`). Le projet ne définit pas de linter dédié à ce jour ; la CI ne
gagne donc pas de règle qui n'existe nulle part ailleurs dans le dépôt.
