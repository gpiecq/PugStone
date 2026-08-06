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
