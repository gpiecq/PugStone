import { ChannelType, Client, type TextChannel } from 'discord.js'
import type { DiscordGateway, MessagePayload } from '../broadcast/gateway.js'

/**
 * Implémentation concrète de DiscordGateway (Tâche 4) au-dessus de discord.js.
 * Un salon introuvable ou non textuel est traduit en erreur portant le code
 * numérique 10003 (« Unknown Channel » côté API Discord) : c'est le même code
 * que discord.js remonte nativement pour un salon supprimé, ce qui permet à
 * classifyDiscordError (Tâche 4) de traiter les deux cas identiquement et au
 * worker d'émission (Tâche 9) de basculer le serveur en NEEDS_ATTENTION.
 */
export class DiscordJsGateway implements DiscordGateway {
  constructor(private readonly client: Client) {}

  private async textChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw Object.assign(new Error('salon introuvable ou non textuel'), { code: 10003 })
    }
    return channel as TextChannel
  }

  async sendMessage(channelId: string, payload: MessagePayload): Promise<{ messageId: string }> {
    const channel = await this.textChannel(channelId)
    const message = await channel.send(payload as never)
    return { messageId: message.id }
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<void> {
    const channel = await this.textChannel(channelId)
    const message = await channel.messages.fetch(messageId)
    await message.edit(payload as never)
  }

  async sendDM(userId: string, payload: MessagePayload): Promise<{ channelId: string; messageId: string }> {
    const user = await this.client.users.fetch(userId)
    const dm = await user.createDM()
    const message = await dm.send(payload as never)
    return { channelId: dm.id, messageId: message.id }
  }

  async createPrivateThread(channelId: string, name: string, inviteUserId: string): Promise<{ channelId: string }> {
    const channel = await this.textChannel(channelId)
    const thread = await channel.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
    })
    await thread.members.add(inviteUserId)
    return { channelId: thread.id }
  }

  /**
   * Un serveur introuvable (bot expulsé) ou un propriétaire qui ne peut plus
   * être résolu sont tous deux traduits en 10003, exactement comme
   * `textChannel` : le worker d'émission (Tâche 9) n'a pas besoin de
   * distinguer ces deux cas, seulement de savoir que la cible est inutilisable.
   */
  async fetchGuildOwnerId(discordGuildId: string): Promise<string> {
    try {
      const guild = await this.client.guilds.fetch(discordGuildId)
      const owner = await guild.fetchOwner()
      return owner.id
    } catch {
      throw Object.assign(new Error('serveur ou propriétaire introuvable'), { code: 10003 })
    }
  }
}
