# PugStone — Spécification de conception

**Date :** 2026-08-06
**Statut :** validé (conception)
**Périmètre :** v1, boucle fonctionnelle complète

---

## 1. Objet

PugStone est un bot Discord destiné aux communautés World of Warcraft. Il constitue un réseau LFG inter-serveurs fermé : un Raid Leader publie depuis son serveur une annonce détaillant les places manquantes de son roster, le bot la diffuse sur l'ensemble des serveurs partenaires, collecte les candidatures via des modals, et présente au Raid Leader un tableau de bord privé pour comparer les candidats et retenir le bon.

Le bot ne gère pas la composition du raid en amont (rôle tenu par Raid-Helper ou équivalent) : il traite uniquement le comblement des trous.

### Critères de réussite

- Un Raid Leader publie une annonce en moins d'une minute et reçoit les candidatures sans quitter Discord.
- Une place pourvue se reflète sur tous les serveurs du réseau sans intervention manuelle.
- Aucune place ne peut être attribuée deux fois, même en cas de clics simultanés.
- Un redémarrage ou une panne temporaire ne laisse jamais le réseau dans un état incohérent.

---

## 2. Décisions structurantes

| Décision | Choix retenu | Motivation |
|---|---|---|
| Langage / librairie | Node.js + TypeScript + discord.js v14 | Support natif complet des composants interactifs ; typage précieux sur un domaine à états multiples |
| Base de données | PostgreSQL + Prisma | Transactions et verrouillage de ligne, nécessaires contre les accès concurrents sur une place |
| Hébergement | VPS + Docker Compose (`bot` + `postgres`) | Maîtrise complète, aucune dépendance à un fournisseur |
| Modèle de réseau | Fermé, sur invitation | Qualité des annonces maîtrisée, pas de diffusion subie |
| Admission | Code d'invitation à usage unique | Aucun back-office à construire, aucune validation manuelle après coup |
| Droit de publier | Rôle(s) Discord désigné(s) par l'admin du serveur | Chaque serveur garde la main sur qui s'exprime en son nom sur le réseau |
| Cycle de vie | Expiration automatique à l'heure du raid + clôture manuelle | Évite l'accumulation d'annonces mortes sur le réseau |
| Synchronisation | Table d'émission (outbox) en base + worker interne | Reprise automatique après crash sans infrastructure supplémentaire |
| Emojis de classes/spés | Application Emojis (attachés au bot) | Seul moyen d'afficher les mêmes icônes sur tous les serveurs sans serveur d'emojis ni Nitro |

### Approches écartées

- **Diffusion directe sans table d'émission.** Un crash en plein fan-out laisse l'annonce publiée sur une partie du réseau seulement, sans trace du travail restant.
- **File externe (Redis / BullMQ) et worker séparé.** Surdimensionné pour un réseau fermé de quelques dizaines de serveurs ; ajoute un service à déployer, surveiller et sauvegarder. Le modèle de données retenu permet de basculer vers cette architecture plus tard sans migration : il suffirait de remplacer la boucle du worker par un consommateur de file.

---

## 3. Architecture

Un process Node unique héberge trois boucles indépendantes :

1. **Client Discord** — passerelle temps réel, réception et traitement des interactions.
2. **Worker d'émission** — publie et met à jour les messages sur le réseau.
3. **Planificateur** — expiration des annonces échues, purge des données anciennes.

Principe directeur : **la logique métier n'importe jamais discord.js**. Un handler d'interaction parse, autorise, délègue à un service, puis rend le résultat. Les services manipulent des données pures et se testent sans l'API Discord. Le rendu des embeds est une fonction pure `état → embed`.

```
src/
  index.ts                 démarrage : client + worker + planificateur
  config/
    env.ts                 validation des variables d'environnement (zod), échec au boot si invalide
                           DISCORD_TOKEN, DISCORD_APP_ID, OWNER_DISCORD_ID, DATABASE_URL, LOG_LEVEL
    wow.ts                 classes, spécialisations, rôles (données statiques)
    emojis.ts              mapping classe/spé → Application Emoji du bot
  bot/
    client.ts              création du client, intents, connexion
    router.ts              aiguillage des interactions par custom_id
    gateway.ts             implémentation de DiscordGateway au-dessus de discord.js
  commands/                /network, /set-lfg-channel, /recruit, /cancel
  interactions/            handlers boutons / select menus / modals
  domain/                  services métier (aucun import discord.js)
    network.ts  events.ts  slots.ts  applications.ts
  broadcast/
    outbox.ts              worker : consomme les lignes EventMessage en retard
    render.ts              état → embed + composants (fonctions pures)
  scheduler/
    expiration.ts          passage des annonces échues en EXPIRED
    retention.ts           purge quotidienne
  db/                      client Prisma + repositories
prisma/schema.prisma
```

### Frontière avec Discord

Une seule interface, `DiscordGateway`, expose `sendMessage`, `editMessage`, `sendDM`, `createPrivateThread`. Le worker et les services ne connaissent qu'elle. En test, une implémentation en mémoire enregistre les appels et simule n'importe quel code d'erreur Discord.

### Langue des textes

**Tous les textes destinés aux utilisateurs sont en anglais** : embeds publics, libellés de composants, messages éphémères, messages privés, noms et descriptions des commandes. Le réseau est international (EU/US) et la terminologie WoW l'est de fait. Les exemples formulés en français dans ce document décrivent l'intention, pas la formulation finale. Le code, les commentaires et la documentation interne restent en français.

### Routage des interactions

Discord ne transporte que le `custom_id` (100 caractères maximum) entre le clic et le handler. Format retenu, versionné : `pug:1:<domaine>:<action>:<id>` — par exemple `pug:1:app:open:c1f2...`.

Aucune donnée métier n'y est encodée, uniquement des identifiants : l'état vit en base. Les composants sont donc **persistants**, c'est-à-dire qu'ils continuent de fonctionner après un redémarrage du bot, contrairement aux vues conservées en mémoire. Le préfixe versionné permet de faire évoluer le format sans casser les annonces déjà publiées.

---

## 4. Modèle de données

```prisma
enum GuildStatus     { ACTIVE  NEEDS_ATTENTION  SUSPENDED }
enum Difficulty      { NORMAL  HEROIC  MYTHIC }
enum EventStatus     { DRAFT  PUBLISHED  COMPLETED  EXPIRED  CANCELLED }
enum SlotStatus      { OPEN  FILLED }
enum AppStatus       { PENDING  ACCEPTED  DISCARDED }
enum WowRole         { TANK  HEALER  DPS }
enum MessageKind     { PUBLIC  DASHBOARD }

model Guild {
  id               String      @id @default(cuid())
  discordGuildId   String      @unique
  lfgChannelId     String?                  // null tant que /set-lfg-channel n'a pas été fait
  recruiterRoleIds String[]                 // rôles autorisés à /recruit
  timezone         String                   // IANA, ex. "Europe/Paris"
  status           GuildStatus @default(ACTIVE)
  statusReason     String?                  // motif du passage en NEEDS_ATTENTION
  joinedAt         DateTime    @default(now())
}

model InviteCode {
  code        String    @id                 // généré, court, non devinable
  createdBy   String                        // Discord ID de l'owner du bot
  usedByGuild String?   @unique             // null tant qu'inutilisé
  usedAt      DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
}

model Event {
  id                 String      @id @default(cuid())
  originGuildId      String                     // serveur émetteur
  authorId           String                     // Discord ID du Raid Leader
  authorContact      String                     // pseudo Bnet/in-game transmis aux acceptés
  raidName           String
  difficulty         Difficulty
  scheduledAt        DateTime                   // stocké en UTC
  status             EventStatus @default(DRAFT)
  publicVersion      Int         @default(0)    // incrémenté à chaque changement visible publiquement
  dashboardVersion   Int         @default(0)    // incrémenté à chaque changement visible du dashboard
  dashboardChannelId String?                    // DM du RL, ou thread privé de repli
  dashboardMessageId String?
  createdAt          DateTime    @default(now())
}

model Slot {
  id                    String     @id @default(cuid())
  eventId               String
  className             String                  // ex. "MAGE"
  specName              String                  // ex. "ARCANE"
  role                  WowRole
  status                SlotStatus @default(OPEN)
  acceptedApplicationId String?    @unique
  position              Int                     // ordre d'affichage
}

model Application {
  id          String    @id @default(cuid())
  slotId      String
  applicantId String                            // Discord ID
  applicantTag String                           // pseudo au moment de la candidature (repli d'affichage)
  ignRealm    String
  itemLevel   Int
  logsUrl     String
  comment     String?
  status      AppStatus @default(PENDING)
  createdAt   DateTime  @default(now())

  @@unique([slotId, applicantId])               // une seule candidature par joueur et par place
}

model EventMessage {
  id            String      @id @default(cuid())
  eventId       String
  guildId       String                          // serveur cible ; pour DASHBOARD : serveur émetteur
  channelId     String
  messageId     String?                         // null tant que le message n'est pas publié
  kind          MessageKind
  syncedVersion Int         @default(-1)        // version de l'Event reflétée par ce message
  disabled      Boolean     @default(false)     // plus aucune tentative (message supprimé, serveur parti)
  attempts      Int         @default(0)
  nextAttemptAt DateTime    @default(now())
  lastError     String?

  @@unique([eventId, guildId, kind])
}
```

### Mécanique de synchronisation

Toute modification visible d'une annonce incrémente un compteur de version, **dans la même transaction** que le changement métier :

- Nouvelle candidature, mise à jour d'une candidature existante → `dashboardVersion++`
- Place pourvue, clôture, expiration, annulation → `publicVersion++` **et** `dashboardVersion++`

Le worker sélectionne en boucle les lignes `EventMessage` non désactivées dont `syncedVersion` est inférieur au compteur correspondant à leur `kind` et dont `nextAttemptAt` est dépassé. Il régénère le rendu à partir de l'état courant, envoie le message si `messageId` est null, sinon l'édite, puis écrit `syncedVersion` à la valeur lue.

Trois propriétés en découlent :

- **Idempotence.** Rejouer une synchronisation n'a aucun effet de bord. Un crash entre l'édition et l'écriture de `syncedVersion` provoque au pire une édition identique refaite.
- **Coalescence.** Trois places pourvues en dix secondes ne produisent qu'une seule édition, vers l'état final — précieux face aux limites de débit de Discord.
- **Convergence.** Un serveur temporairement injoignable rattrape son retard tout seul, sans file d'attente qui gonfle : il n'existe jamais qu'une ligne par annonce, par serveur et par type.

### Choix de modélisation

**Une ligne `Slot` par place.** Un besoin de deux DPS Mage Arcane crée deux slots identiques plutôt qu'un slot avec un champ `quantity`. Chaque place se remplit indépendamment, le verrouillage anti-concurrence reste trivial, et le suivi des candidatures n'a pas à gérer de compteur partiel. L'affichage agrège les slots identiques (`Arcane (2 places)`).

**Heures en UTC, affichage dynamique.** `/recruit time:` accepte `JJ/MM HH:MM`, ou `HH:MM` interprété comme la prochaine occurrence (aujourd'hui si l'heure n'est pas passée, demain sinon). La saisie est interprétée dans le fuseau déclaré par le serveur émetteur, stockée en UTC, et affichée dans les embeds sous forme de timestamp Discord dynamique (`<t:...:F>`) : chaque lecteur du réseau voit alors l'heure dans son propre fuseau, condition nécessaire pour un réseau EU/US.

---

## 5. Flux fonctionnels

### 5.1 Admission au réseau

`/network invite` (réservée à l'owner du bot) génère un code à usage unique. `/network revoke <code>` l'invalide. `/network status` affiche l'état du réseau : serveurs actifs, serveurs en `NEEDS_ATTENTION` avec leur motif, lignes d'émission bloquées.

L'admin d'un serveur exécute `/set-lfg-channel code:<code> channel:#lfg roles:@RaidLead timezone:Europe/Paris`. Le bot :

1. valide le code dans une transaction avec verrou (`FOR UPDATE`) — refus si consommé, révoqué ou inexistant ;
2. crée le `Guild` et marque le code consommé ;
3. vérifie qu'il dispose réellement de `ViewChannel`, `SendMessages` et `EmbedLinks` sur le salon, et le signale immédiatement sinon.

Rejouer la commande **sans** code permet à l'admin de modifier le salon, les rôles recruteurs ou le fuseau horaire.

### 5.2 Création de l'annonce

`/recruit raid:<nom> difficulty:<NM|HM|MM> time:<heure>` :

1. vérification de l'appartenance à l'un des `recruiterRoleIds` du serveur ;
2. refus si l'heure indiquée est déjà passée ;
3. création d'un `Event` en `DRAFT` ;
4. réponse **éphémère** contenant le constructeur de roster.

Le constructeur comprend : un select menu de classe, un select menu de spécialisation dépendant de la classe choisie, un bouton `[+ Ajouter]`, la liste des places déjà définies avec un select `[Retirer]`, un champ de contact (pseudo Bnet/in-game) et le bouton `[Publish LFG]`. Chaque interaction persiste le brouillon en base et ré-édite le message éphémère : un rechargement de Discord ou un redémarrage du bot ne perd pas le travail en cours.

`[Publish LFG]` refuse un roster vide et refuse la publication si aucun serveur partenaire n'est actif (l'annonce reste alors en `DRAFT`). Sinon, dans une seule transaction : passage en `PUBLISHED`, insertion d'une ligne `EventMessage` `PUBLIC` par serveur partenaire actif et d'une ligne `DASHBOARD`. Le worker prend le relais ; l'annonce apparaît sur le réseau en quelques secondes.

### 5.3 Embed public

- **Titre** — `🚨 LFG - <Raid> (<Difficulté>)`, préfixé de `[COMPLETED]`, `[EXPIRED]` ou `[CANCELLED]` selon l'état.
- **Corps** — heure sous forme de timestamp dynamique, contact du Raid Leader, serveur émetteur.
- **Places** — une ligne par place : `🔸 <emoji classe> <Spé> (Open)` ou `✅ <emoji classe> <Spé> (Filled)`. Les places identiques sont agrégées.
- **Composant** — bouton `[⚔️ Apply]`, désactivé dès que l'annonce n'est plus `PUBLISHED`.

### 5.4 Candidature

Clic sur `[⚔️ Apply]`. Le bot lit l'état courant :

- annonce close → message éphémère explicatif ;
- **une seule** place ouverte → le modal s'ouvre directement ;
- **plusieurs** places ouvertes → select éphémère « Pour quel rôle postules-tu ? », puis modal.

Cette distinction est imposée par Discord : un modal doit être la **première** réponse à une interaction, il est impossible de différer puis d'ouvrir un modal. Le chemin « select puis modal » ne fonctionne que parce que la sélection constitue une nouvelle interaction.

Champs du modal :

1. `In-game Name & Realm` — texte court, requis
2. `Item Level (iLvl)` — texte court, requis
3. `WarcraftLogs Link` — texte court, requis
4. `Comments for RL` — texte long, optionnel

À la soumission : validation (entier dans une plage plausible pour l'iLvl, hôte `warcraftlogs.com` pour le lien, longueurs maximales). Un refus est renvoyé en éphémère avec le détail précis de ce qui ne va pas — Discord perd les valeurs saisies, le message doit donc suffire à ressaisir sans tâtonner.

Puis, en transaction : verrou sur le slot, refus si entre-temps il est `FILLED`, insertion de l'`Application`, `dashboardVersion++`. Confirmation éphémère au joueur. Une nouvelle candidature du même joueur sur la même place met à jour la précédente au lieu d'en créer une seconde.

### 5.5 Dashboard du Raid Leader

Un **message unique en DM**, ré-édité à chaque évolution. Il liste les places, et sous chacune les candidats au format `Pseudo-Royaume | iLvl: 626 | [Logs] | commentaire`, avec un select menu `Accepter…`. Un bouton `[Fermer l'annonce]` y figure également.

Si le Raid Leader a fermé ses messages privés, l'envoi échoue : le bot crée alors un **thread privé** dans le salon LFG du serveur émetteur et l'y invite, en le signalant dans la réponse éphémère de publication.

### 5.6 Acceptation

En une transaction : verrou du slot, refus si déjà `FILLED` (« cette place vient d'être pourvue »), passage de l'`Application` retenue en `ACCEPTED` et des concurrentes sur cette place en `DISCARDED`, slot `FILLED`, `publicVersion++` et `dashboardVersion++`. Si plus aucune place n'est ouverte, l'annonce passe en `COMPLETED`.

Puis DM au joueur retenu : « Tu as été accepté pour le raid `<nom>`. Murmure à `<contact du RL>` pour l'invitation. » Si ses messages privés sont fermés, le Raid Leader en est informé sur son dashboard, avec la mention du joueur, à charge pour lui de le contacter.

Le worker répercute ensuite l'état sur tous les messages du réseau : la place passe en `✅ Filled`, et si l'annonce est `COMPLETED`, le titre est préfixé et le bouton `[⚔️ Apply]` désactivé.

### 5.7 Clôture

- `/cancel` (auteur de l'annonce uniquement) ou le bouton `[Fermer l'annonce]` → `CANCELLED`.
- Le planificateur passe en `EXPIRED`, toutes les minutes, les annonces `PUBLISHED` dont `scheduledAt` est dépassé.

Dans les deux cas, `publicVersion++` suffit : le worker met à jour les embeds du réseau sans code spécifique à ces transitions.

---

## 6. Erreurs, concurrence et cas limites

Chaque erreur relève de l'une de trois familles : **faute d'utilisateur** (message éphémère explicite), **panne transitoire** (retry automatique par l'outbox), **échec permanent** (arrêt des tentatives et signalement). Les deux comportements à proscrire sont le retry infini sur une cible morte et le silence sur une cible cassée.

### Contraintes propres aux interactions

Une interaction doit recevoir une réponse en **3 secondes**. Tout handler effectuant plusieurs requêtes en base commence donc par `deferReply({ ephemeral: true })` — sauf les chemins ouvrant un modal, où le report est interdit : ceux-là se limitent à une lecture courte sur index.

Un `try/catch` global autour du routeur garantit qu'**aucune interaction ne reste sans réponse** : toute exception imprévue produit un message éphémère générique et une entrée de log corrélée. Un bug ne doit jamais se manifester par un bouton qui tourne indéfiniment.

### Concurrence

Trois protections superposées :

1. **Verrou de ligne** (`SELECT … FOR UPDATE`) sur le `Slot` lors de la candidature et de l'acceptation. Deux joueurs cliquant à la même milliseconde sont sérialisés par Postgres ; le second reçoit un refus explicite.
2. **Contraintes d'unicité** en base (`@@unique([slotId, applicantId])`, `acceptedApplicationId @unique`, `@@unique([eventId, guildId, kind])`) : même en cas de bug applicatif, l'état incohérent est impossible à écrire.
3. **`FOR UPDATE SKIP LOCKED`** dans la boucle du worker, ce qui rend inoffensifs deux ticks qui se chevauchent — ou un second process ultérieur.

### Politique de retry du worker

Traitement par lots, concurrence globale plafonnée à environ 5 requêtes simultanées (`p-limit`). discord.js gère déjà ses files par route et les réponses `429` ; le plafond évite simplement de lui empiler deux cents envois d'un coup.

- **Erreur transitoire** (`5xx`, timeout réseau, `429` inattendu) → `attempts++`, `nextAttemptAt` en backoff exponentiel avec jitter (≈ 5 s, 15 s, 1 min, 5 min, 15 min…), abandon au-delà de 8 tentatives avec conservation de `lastError` et alerte à l'owner.
- **Erreur permanente**, identifiée par code Discord :
  - `50001 Missing Access`, `50013 Missing Permissions`, `10003 Unknown Channel` à la publication → serveur marqué `NEEDS_ATTENTION` avec motif, exclu des diffusions suivantes, admin du serveur prévenu, owner informé.
  - `10008 Unknown Message` à l'édition → un modérateur a supprimé le message. Aucune republication (ce serait ignorer une décision locale) : la ligne passe `disabled = true`.
- **Expulsion du bot** (`guildDelete`) → serveur `SUSPENDED`, toutes ses lignes d'émission désactivées.

### Cas limites traités

| Situation | Comportement |
|---|---|
| Publication alors qu'aucun partenaire n'est actif | Refus éphémère, l'annonce reste en `DRAFT` |
| Raid Leader avec DM fermés | Bascule sur un thread privé dans le salon LFG du serveur émetteur |
| Joueur accepté avec DM fermés | Le Raid Leader est prévenu sur son dashboard, avec la mention du joueur |
| Candidat ayant quitté le serveur ou supprimé son compte | La candidature reste affichée, repli sur `applicantTag` |
| Deux acceptations simultanées sur la même place | Verrou de ligne : la seconde reçoit un refus éphémère |
| Redémarrage en plein fan-out | Le worker reprend seul : `syncedVersion < publicVersion` identifie le travail restant |
| Annonce créée pour une heure déjà passée | Refus à la validation de `/recruit` |
| Salon LFG supprimé après configuration | Détecté à la première diffusion → `NEEDS_ATTENTION` + notification de l'admin |
| Liste de candidats dépassant les limites Discord | Troncature explicite (25 options de select, 6000 caractères d'embed) avec mention du nombre masqué |

### Observabilité et rétention

Logs structurés (pino) portant `eventId`, `guildId` et `interactionId`. `/network status` expose le nombre de serveurs actifs, ceux en `NEEDS_ATTENTION` avec leur motif, et le nombre de lignes d'émission bloquées.

Purge quotidienne des annonces terminées depuis plus de 30 jours et de leurs candidatures — autant pour la taille de la base que pour ne pas conserver indéfiniment des données de joueurs.

---

## 7. Stratégie de test

Développement piloté par les tests : chaque comportement s'écrit d'abord comme test rouge.

| Niveau | Couverture | Outillage |
|---|---|---|
| Domaine | Admission par code, refus d'un code consommé, candidature sur place fermée, acceptation entraînant le rejet des concurrentes, clôture quand toutes les places sont pourvues, refus d'un raid déjà passé | Vitest + Postgres réel (base de test dédiée, migrations Prisma, rollback entre tests) |
| Concurrence | Deux candidatures puis deux acceptations réellement parallèles sur la même place : exactement une gagne, l'autre est refusée proprement | Vitest + Postgres réel, connexions distinctes |
| Rendu | Embed public dans chaque état, dashboard à 0, 1 et N candidats, troncature aux limites Discord | Snapshots sur fonctions pures |
| Worker | Publication puis édition, coalescence de plusieurs versions en une édition, backoff sur erreur transitoire, abandon après 8 tentatives, désactivation sur `10008`, `NEEDS_ATTENTION` sur `50013` | `DiscordGateway` en mémoire, horloge injectée |
| Handlers | Aiguillage des `custom_id`, contrôle du rôle recruteur, réponse éphémère en cas d'erreur, aucune interaction laissée sans réponse | Doubles typés d'objets d'interaction |

L'usage de Postgres réel plutôt que d'une base en mémoire est indispensable : la correction du bot repose sur `SELECT … FOR UPDATE` et sur les contraintes d'unicité, que seul le vrai moteur reproduit.

**Hors périmètre automatisé :** l'API Discord elle-même. Une checklist de fumée manuelle sur deux serveurs de test (un émetteur, un récepteur) couvre le parcours complet et se rejoue avant chaque mise en production.

**Intégration continue** (GitHub Actions) : lint, typecheck, migrations et suite complète avec un service Postgres. Aucune fusion vers `develop` sans CI verte.

---

## 8. Hors périmètre v1

Ces éléments sont volontairement exclus ; le modèle de données les accueille sans migration lourde le jour venu.

- Filtres de diffusion par langue, région ou difficulté côté serveur receveur.
- Quotas anti-flood par utilisateur ou par serveur.
- Statistiques et historique de recrutement.
- Interface web d'administration.
- Intégration directe avec Raid-Helper ou l'API Blizzard (vérification automatique de l'iLvl).
- Traduction des messages du bot dans d'autres langues que l'anglais.
- Désistement d'un candidat après soumission : en v1, un joueur qui ne peut plus venir le signale au Raid Leader hors du bot. Le Raid Leader peut de toute façon accepter un autre candidat tant que la place n'est pas pourvue.
