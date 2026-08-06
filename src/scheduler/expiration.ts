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
