import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// Prisma 7 exige un driver adapter explicite : le client ne lit plus
// `DATABASE_URL` tout seul depuis le schéma (voir prisma.config.ts pour la CLI).
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL doit être défini')

const adapter = new PrismaPg({ connectionString: url })

export const prisma = new PrismaClient({ adapter })
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
