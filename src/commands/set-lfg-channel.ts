import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction, type GuildTextBasedChannel } from 'discord.js'
import type { BotDeps } from '../bot/router.js'
import { checkChannelPermissions } from '../bot/permissions.js'
import { redeemInviteCode, updateGuildConfig } from '../domain/network.js'
import { DomainError } from '../domain/errors.js'

export const setLfgChannelCommand = {
  data: new SlashCommandBuilder()
    .setName('set-lfg-channel')
    .setDescription('Join the PugStone network or update this server configuration')
    .setDefaultMemberPermissions(0) // administrateurs uniquement, par défaut Discord
    .addChannelOption((o) => o.setName('channel').setDescription('Channel receiving LFG listings')
      .addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('roles').setDescription('Role allowed to post listings').setRequired(true))
    .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. Europe/Paris').setRequired(true))
    .addStringOption((o) => o.setName('code').setDescription('Invite code (first setup only)')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const channel = interaction.options.getChannel('channel', true) as GuildTextBasedChannel
    const role = interaction.options.getRole('roles', true)
    const timezone = interaction.options.getString('timezone', true)
    const code = interaction.options.getString('code')

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
          recruiterRoleIds: [role.id], timezone,
        })
        await interaction.editReply(`This server joined the PugStone network. Listings will be posted in ${channel}.`)
      } else {
        await updateGuildConfig(deps.db, {
          discordGuildId: interaction.guildId!, lfgChannelId: channel.id,
          recruiterRoleIds: [role.id], timezone,
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
