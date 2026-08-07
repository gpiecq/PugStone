import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction, type GuildTextBasedChannel } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { checkChannelPermissions } from '../bot/permissions.js'
import { redeemInviteCode, updateGuildConfig } from '../domain/network.js'
import { DomainError } from '../domain/errors.js'

/**
 * Discord ne propose pas de sélecteur multi-rôles dans une commande : la
 * façon idiomatique est d'exposer plusieurs options de rôle (`role`,
 * `role2`, `role3`) et de fusionner leurs identifiants. Dédoublonne : rien
 * n'empêche l'admin de choisir deux fois le même rôle sur des options
 * distinctes.
 */
export function collectRecruiterRoleIds(roleIds: (string | null | undefined)[]): string[] {
  return [...new Set(roleIds.filter((id): id is string => Boolean(id)))]
}

export const setLfmChannelCommand = {
  data: new SlashCommandBuilder()
    .setName('set-lfm-channel')
    .setDescription('Join the PugStone network or update this server configuration')
    .setDefaultMemberPermissions(0) // administrateurs uniquement, par défaut Discord
    .addChannelOption((o) => o.setName('channel').setDescription('Channel receiving LFM listings')
      .addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('Role allowed to post listings').setRequired(true))
    .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. Europe/Paris').setRequired(true))
    // Facultatives : doivent suivre toutes les options requises ci-dessus,
    // sinon Discord refuse l'enregistrement de la commande.
    .addRoleOption((o) => o.setName('role2').setDescription('Additional role allowed to post listings'))
    .addRoleOption((o) => o.setName('role3').setDescription('Additional role allowed to post listings'))
    .addStringOption((o) => o.setName('code').setDescription('Invite code (first setup only)')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const channel = interaction.options.getChannel('channel', true) as GuildTextBasedChannel
    const role = interaction.options.getRole('role', true)
    const role2 = interaction.options.getRole('role2')
    const role3 = interaction.options.getRole('role3')
    const timezone = interaction.options.getString('timezone', true)
    const code = interaction.options.getString('code')
    const recruiterRoleIds = collectRecruiterRoleIds([role.id, role2?.id, role3?.id])

    const missing = checkChannelPermissions(channel, interaction.client.user.id)
    if (missing.length > 0) {
      await interaction.editReply(`I am missing these permissions in ${channel}: ${missing.join(', ')}.`)
      return
    }
    if (!Intl.supportedValuesOf('timeZone').includes(timezone)) {
      await interaction.editReply(`\`${timezone}\` is not a valid IANA timezone (e.g. \`Europe/Paris\`).`)
      return
    }

    try {
      if (code) {
        await redeemInviteCode(deps.db, {
          code, discordGuildId: interaction.guildId!, lfgChannelId: channel.id,
          recruiterRoleIds, timezone, name: interaction.guild?.name,
        })
        await interaction.editReply(`This server joined the PugStone network. Listings will be posted in ${channel}.`)
      } else {
        // Rejouer la commande est le seul chemin de rattrapage pour un serveur
        // inscrit avant l'ajout de `Guild.name` (Tâche 18) : ce champ se met
        // à jour au passage, sans mécanisme de synchronisation dédié.
        await updateGuildConfig(deps.db, {
          discordGuildId: interaction.guildId!, lfgChannelId: channel.id,
          recruiterRoleIds, timezone, name: interaction.guild?.name,
        })
        await interaction.editReply('Configuration updated.')
      }
    } catch (error) {
      if (error instanceof DomainError) {
        await interaction.editReply(error.userMessage)
        return
      }
      throw error
    }
  },
}
