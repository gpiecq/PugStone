FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# prisma.config.ts (Prisma 7) exige que DATABASE_URL soit résolvable dès le
# chargement du fichier de config, y compris pour `prisma generate` qui ne se
# connecte pourtant jamais à la base : seule sa forme compte ici, la valeur
# réelle est fournie à l'exécution par docker-compose.yml (service `bot`).
ENV DATABASE_URL=postgresql://pugstone:pugstone@postgres:5432/pugstone
RUN npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# `prisma` (le paquet CLI, distinct de `@prisma/client`) est une dépendance de
# production explicite (package.json) : sans ça, `npm ci --omit=dev` la
# retirerait et `npx prisma migrate deploy` tenterait un téléchargement réseau
# à chaque démarrage du conteneur au lieu d'utiliser le binaire déjà installé.
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY config ./config
# prisma.config.ts (Prisma 7) porte l'URL de connexion utilisée par la CLI
# (`migrate deploy`) : le bloc `datasource` du schéma n'en a pas. Sans ce
# fichier à l'exécution, la CLI ne peut pas résoudre la datasource et le CMD
# ci-dessous échoue avant même de démarrer le bot (revue finale, constat C2).
COPY prisma.config.ts ./prisma.config.ts
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
