// /recruit : point d'entrée du Raid Leader. Crée le brouillon puis affiche
// immédiatement le constructeur de roster (src/interactions/roster.ts) —
// c'est l'écran le plus utilisé du bot.

import { SlashCommandBuilder, type ChatInputCommandInteraction, type GuildMember } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { isRecruiter } from '../bot/permissions.js'
import { createDraft, loadEventView, setContact } from '../domain/events.js'
import { parseRaidTime } from '../domain/time.js'
import { renderRosterBuilder } from '../interactions/roster.js'
import { DomainError } from '../domain/errors.js'

export const recruitCommand = {
  data: new SlashCommandBuilder()
    .setName('recruit')
    .setDescription('Create a cross-server LFM listing')
    .addStringOption((o) => o.setName('raid').setDescription('Raid name').setRequired(true))
    .addStringOption((o) => o.setName('difficulty').setDescription('Difficulty').setRequired(true)
      .addChoices({ name: 'Normal', value: 'NORMAL' }, { name: 'Heroic', value: 'HEROIC' }, { name: 'Mythic', value: 'MYTHIC' }))
    .addStringOption((o) => o.setName('time').setDescription('HH:MM or DD/MM HH:MM').setRequired(true))
    .addStringOption((o) => o.setName('contact').setDescription('Battle.net or in-game name').setRequired(true)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    // deferReply d'abord : les rejets ci-dessous (serveur non inscrit, rôle
    // manquant) doivent apparaître comme la réponse de la commande plutôt que
    // provoquer un « interaction failed » côté Discord.
    await interaction.deferReply({ ephemeral: true })
    const guild = await deps.db.guild.findUnique({ where: { discordGuildId: interaction.guildId! } })
    if (!guild) {
      await interaction.editReply('This server is not part of the PugStone network yet.')
      return
    }

    const member = interaction.member as GuildMember
    if (!isRecruiter([...member.roles.cache.keys()], guild.recruiterRoleIds)) {
      await interaction.editReply('You do not have the role required to post listings on this server.')
      return
    }

    try {
      const scheduledAt = parseRaidTime(interaction.options.getString('time', true), guild.timezone, new Date())
      const draft = await createDraft(deps.db, {
        originGuildId: guild.id,
        authorId: interaction.user.id,
        raidName: interaction.options.getString('raid', true),
        difficulty: interaction.options.getString('difficulty', true) as 'NORMAL' | 'HEROIC' | 'MYTHIC',
        scheduledAt,
      })
      await setContact(deps.db, draft.id, interaction.options.getString('contact', true))
      const view = await loadEventView(deps.db, draft.id)
      await interaction.editReply(renderRosterBuilder(view, null, deps.emojis) as never)
    } catch (error) {
      if (error instanceof DomainError) {
        await interaction.editReply(error.userMessage)
        return
      }
      throw error
    }
  },
}
