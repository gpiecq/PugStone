import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// Prisma 7 exige un driver adapter explicite pour connecter le client : voir
// src/db/client.ts pour la même adaptation côté application.
const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL doit pointer vers une base dédiée aux tests')

const adapter = new PrismaPg({ connectionString: url })

export const testDb = new PrismaClient({ adapter })

export async function resetDb(): Promise<void> {
  // TRUNCATE plutôt que rollback de transaction : les tests de concurrence
  // utilisent des connexions distinctes et ne peuvent pas partager une transaction.
  await testDb.$executeRawUnsafe(
    'TRUNCATE "EventMessage", "Application", "Slot", "Event", "InviteCode", "Guild" RESTART IDENTITY CASCADE',
  )
}
