import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from '../config/env.js'

// Prisma 7 exige un driver adapter explicite : le client ne lit plus
// `DATABASE_URL` tout seul depuis le schéma (voir prisma.config.ts pour la CLI).
// L'URL passe par `env()` (Tâche 1) et non par une lecture ad hoc de
// `process.env` : c'est la seule source de vérité qui valide le format de
// l'URL et agrège les variables fautives dans un message unique au démarrage.
const adapter = new PrismaPg({ connectionString: env().DATABASE_URL })

export const prisma = new PrismaClient({ adapter })
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
