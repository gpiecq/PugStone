import type { Db } from '../db/client.js'

/**
 * Passe en EXPIRED les annonces dont l'heure de raid est dépassée.
 *
 * Le filtre sur PUBLISHED porte directement sur le `where` de l'`updateMany` :
 * Postgres réévalue cette condition sous verrou de ligne au moment d'écrire,
 * pas seulement au moment de la lire. C'est ce qui rend l'opération atomique
 * et idempotente même sous deux ticks concurrents — un `findMany` préalable
 * suivi d'un `updateMany({ where: { id: { in: ... } } })` laisserait une
 * fenêtre entre lecture et écriture où deux passes pourraient toutes deux
 * lire la même annonce encore PUBLISHED et l'incrémenter chacune.
 */
export async function expireDueEvents(db: Db, now: Date): Promise<number> {
  const result = await db.event.updateMany({
    where: { status: 'PUBLISHED', scheduledAt: { lte: now } },
    data: { status: 'EXPIRED', publicVersion: { increment: 1 }, dashboardVersion: { increment: 1 } },
  })
  return result.count
}
