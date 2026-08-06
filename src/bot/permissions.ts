import { PermissionFlagsBits, type GuildTextBasedChannel } from 'discord.js'
import { NotAuthorized } from '../domain/errors.js'

export function assertOwner(userId: string, ownerId: string): void {
  if (userId !== ownerId) throw new NotAuthorized('this owner-only command')
}

export function isRecruiter(memberRoleIds: string[], recruiterRoleIds: string[]): boolean {
  if (recruiterRoleIds.length === 0) return false
  return memberRoleIds.some((role) => recruiterRoleIds.includes(role))
}

const REQUIRED = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
] as const

/** Détecter le problème à la configuration évite une première diffusion qui échoue en silence. */
export function checkChannelPermissions(channel: GuildTextBasedChannel, botId: string): string[] {
  const perms = channel.permissionsFor(botId)
  if (!perms) return REQUIRED.map(([label]) => label)
  return REQUIRED.filter(([, flag]) => !perms.has(flag)).map(([label]) => label)
}
