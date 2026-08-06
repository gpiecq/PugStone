// /cancel : deuxième chemin, en plus du bouton dash:close, vers la même
// fonction de domaine `cancelEvent`. Les deux aboutissent au même contrôle de
// propriété (NotAuthorized) et à la même clôture d'annonce.

import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { cancelEvent } from '../domain/events.js'
import { DomainError } from '../domain/errors.js'

/** Interface minimale de discord.js réellement utilisée par l'autocomplétion (aucune dépendance directe au type d'interaction concret). */
interface AutocompleteInteraction {
  user: { id: string }
  respond: (choices: { name: string; value: string }[]) => Promise<void>
}

export const cancelCommand = {
  data: new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel one of your active listings')
    .addStringOption((o) => o.setName('listing').setDescription('Listing to cancel').setRequired(true).setAutocomplete(true)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    try {
      await cancelEvent(deps.db, interaction.options.getString('listing', true), interaction.user.id)
      await interaction.editReply('Listing cancelled. The network will be updated shortly.')
    } catch (error) {
      if (error instanceof DomainError) {
        await interaction.editReply(error.userMessage)
        return
      }
      throw error
    }
  },

  /**
   * Autocomplétion : uniquement les annonces publiées dont l'appelant est
   * l'auteur — un joueur ne doit jamais voir, même en suggestion, les
   * annonces d'un autre Raid Leader. `take: 25` respecte la limite Discord
   * du nombre de choix proposés.
   */
  async autocomplete(interaction: AutocompleteInteraction, deps: BotDeps): Promise<void> {
    const events = await deps.db.event.findMany({
      where: { authorId: interaction.user.id, status: 'PUBLISHED' },
      orderBy: { scheduledAt: 'asc' },
      take: 25,
    })
    await interaction.respond(events.map((e) => ({ name: `${e.raidName} (${e.difficulty})`.slice(0, 100), value: e.id })))
  },
}
