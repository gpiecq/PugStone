// Décision du Raid Leader : acceptation d'un candidat depuis son dashboard
// privé et clôture de l'annonce. Contrairement au constructeur de roster
// (Tâche 14), les deux handlers ici mutent un état déjà publié au réseau —
// c'est le worker de la Tâche 9 qui se charge de répercuter le changement
// sur le dashboard et les embeds publics au tick suivant, pas ces handlers.

import type { DiscordGateway } from '../broadcast/gateway.js'
import { registerHandler } from '../bot/router.js'
import { acceptApplication } from '../domain/applications.js'
import { cancelEvent } from '../domain/events.js'
import { logger } from '../logger.js'

export interface AcceptedNotice {
  applicantId: string
  contact: string
  raidName: string
}

/** Interfaces minimales de discord.js réellement utilisées par ce module (aucune dépendance directe au paquet, cf. tests/architecture.test.ts pour le domaine — ce module-ci n'y est pas soumis mais suit le même style). */
interface HasStringValues { values: string[] }
interface HasUser { user: { id: string } }
interface DefersReply { deferReply(options: unknown): Promise<void> }
interface EditsReply { editReply(options: unknown): Promise<void> }

/**
 * Un DM refusé ne doit jamais faire échouer l'acceptation : la place est déjà
 * attribuée en base. On rend l'information au RL pour qu'il prenne le relais.
 */
export async function notifyAccepted(gateway: DiscordGateway, notice: AcceptedNotice): Promise<{ delivered: boolean }> {
  try {
    await gateway.sendDM(notice.applicantId, {
      content: `You have been accepted for **${notice.raidName}**. Whisper \`${notice.contact}\` for the invite.`,
      embeds: [], components: [],
    })
    return { delivered: true }
  } catch (error) {
    logger.warn({ err: error, applicantId: notice.applicantId }, 'DM au candidat retenu impossible')
    return { delivered: false }
  }
}

export function registerDashboardHandlers(): void {
  registerHandler('dash', 'accept', async (ctx) => {
    const applicationId = (ctx.interaction as unknown as HasStringValues).values[0]!
    const interaction = ctx.interaction as unknown as HasUser & DefersReply & EditsReply
    await interaction.deferReply({ ephemeral: true })

    const result = await acceptApplication(ctx.deps.db, { applicationId, actorId: interaction.user.id })
    const { delivered } = await notifyAccepted(ctx.deps.gateway, result)

    await interaction.editReply({
      content: delivered
        ? `Player accepted and notified.${result.eventCompleted ? ' All spots are filled — the listing is now closed.' : ''}`
        : `Player accepted, but I could not DM them (their DMs are closed). Please contact <@${result.applicantId}> directly.`,
    })
    // Le dashboard et les embeds publics se mettront à jour au prochain tick du worker.
  })

  registerHandler('dash', 'close', async (ctx) => {
    const interaction = ctx.interaction as unknown as HasUser & DefersReply & EditsReply
    await interaction.deferReply({ ephemeral: true })
    await cancelEvent(ctx.deps.db, ctx.id, interaction.user.id)
    await interaction.editReply({ content: 'Listing closed. The network will be updated shortly.' })
  })
}
