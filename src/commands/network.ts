import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import type { Db } from '../db/client.js'
import type { BotDeps } from '../bot/router.js'
import { assertOwner } from '../bot/permissions.js'
import { createInviteCode, revokeInviteCode } from '../domain/network.js'
import { DomainError } from '../domain/errors.js'

export async function buildNetworkStatus(db: Db): Promise<string> {
  const [active, attention, blocked] = await Promise.all([
    db.guild.findMany({ where: { status: 'ACTIVE', lfgChannelId: { not: null } } }),
    db.guild.findMany({ where: { status: 'NEEDS_ATTENTION' } }),
    db.eventMessage.count({ where: { disabled: true } }),
  ])
  return [
    `**PugStone network**`,
    `Active partners: ${active.length}`,
    `Needs attention: ${attention.length}`,
    ...attention.map((g) => `  • \`${g.discordGuildId}\` — ${g.statusReason ?? 'unknown reason'}`),
    `Disabled deliveries: ${blocked}`,
  ].join('\n')
}

export const networkCommand = {
  data: new SlashCommandBuilder()
    .setName('network')
    .setDescription('Manage the PugStone partner network (bot owner only)')
    .addSubcommand((s) => s.setName('invite').setDescription('Generate a single-use invite code'))
    .addSubcommand((s) => s.setName('revoke').setDescription('Revoke an unused invite code')
      .addStringOption((o) => o.setName('code').setDescription('Invite code').setRequired(true)))
    .addSubcommand((s) => s.setName('status').setDescription('Show network health')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
    // deferReply d'abord : assertOwner peut lever avant que l'interaction soit
    // accusée réception, sans quoi Discord affiche « interaction failed » au
    // lieu du message d'erreur prévu pour le chemin négatif principal de cette
    // commande (un non-owner qui essaie /network).
    await interaction.deferReply({ ephemeral: true })

    try {
      assertOwner(interaction.user.id, deps.ownerId)

      switch (interaction.options.getSubcommand()) {
        case 'invite': {
          const code = await createInviteCode(deps.db, interaction.user.id)
          await interaction.editReply(
            `Invite code: \`${code}\`\nThe partner admin runs \`/set-lfg-channel code:${code} channel:#lfg roles:@RaidLead timezone:Europe/Paris\`.`,
          )
          return
        }
        case 'revoke': {
          await revokeInviteCode(deps.db, interaction.options.getString('code', true))
          await interaction.editReply('Code revoked if it was still unused.')
          return
        }
        default:
          await interaction.editReply(await buildNetworkStatus(deps.db))
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
