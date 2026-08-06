import type { Db } from '../db/client.js'

const DEFAULT_RETENTION_DAYS = 30
// Un brouillon abandonné (jamais publié, jamais annulé) n'a ni `closedAt` ni
// aucune autre trace de clôture : sans cette règle dédiée, il restait en base
// pour toujours, places comprises (revue finale, constat I8). Fenêtre plus
// courte que la rétention des annonces closes : un brouillon n'a par
// construction aucune valeur au-delà de la session où le RL l'a laissé.
const DRAFT_RETENTION_DAYS = 7

/**
 * Les places, candidatures et lignes d'émission partent en cascade avec l'annonce.
 *
 * La rétention des annonces closes s'ancre sur `closedAt` (l'instant réel de
 * clôture), pas sur `scheduledAt` (la date de raid prévue) : une annonce
 * annulée bien avant sa date ne doit pas rester en base jusqu'à 30 jours
 * après le raid initialement prévu. Le repli sur `scheduledAt` quand
 * `closedAt` est nul ne sert qu'aux annonces closes avant l'introduction de
 * ce champ (non rétro-rempli par la migration).
 *
 * Les brouillons suivent une règle distincte, ancrée sur `createdAt` : ils
 * n'ont pas de `closedAt` (jamais close) ni de `scheduledAt` fiable (un
 * brouillon peut être retravaillé indéfiniment avant publication).
 */
export async function purgeOldEvents(db: Db, now: Date, retentionDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const draftCutoff = new Date(now.getTime() - DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const result = await db.event.deleteMany({
    where: {
      OR: [
        {
          status: { in: ['COMPLETED', 'EXPIRED', 'CANCELLED'] },
          OR: [{ closedAt: { lt: cutoff } }, { closedAt: null, scheduledAt: { lt: cutoff } }],
        },
        { status: 'DRAFT', createdAt: { lt: draftCutoff } },
      ],
    },
  })
  return result.count
}
