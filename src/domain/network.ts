import { randomBytes } from 'node:crypto'
import type { Guild } from '@prisma/client'
import type { Db } from '../db/client.js'
import { GuildNotOnboarded, InviteCodeUnusable } from './errors.js'

/** Base 32 sans caractères ambigus : un code se dicte à l'oral sans confusion. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateCode(): string {
  return [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('')
}

export async function createInviteCode(db: Db, ownerId: string): Promise<string> {
  const code = generateCode()
  await db.inviteCode.create({ data: { code, createdBy: ownerId } })
  return code
}

export async function revokeInviteCode(db: Db, code: string): Promise<void> {
  await db.inviteCode.updateMany({
    where: { code, usedByGuild: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export interface RedeemParams {
  code: string
  discordGuildId: string
  lfgChannelId: string
  recruiterRoleIds: string[]
  timezone: string
}

export async function redeemInviteCode(db: Db, params: RedeemParams): Promise<Guild> {
  return db.$transaction(async (tx) => {
    // Verrou de ligne : deux serveurs qui soumettent le même code au même instant
    // sont sérialisés ici, le second constate que usedByGuild n'est plus null.
    const rows = await tx.$queryRaw<{ code: string; usedByGuild: string | null; revokedAt: Date | null }[]>`
      SELECT code, "usedByGuild", "revokedAt" FROM "InviteCode" WHERE code = ${params.code} FOR UPDATE
    `
    const invite = rows[0]
    if (!invite || invite.usedByGuild || invite.revokedAt) throw new InviteCodeUnusable()

    const guild = await tx.guild.create({
      data: {
        discordGuildId: params.discordGuildId,
        lfgChannelId: params.lfgChannelId,
        recruiterRoleIds: params.recruiterRoleIds,
        timezone: params.timezone,
        status: 'ACTIVE',
      },
    })
    await tx.inviteCode.update({
      where: { code: params.code },
      data: { usedByGuild: guild.id, usedAt: new Date() },
    })
    return guild
  })
}

export interface UpdateGuildParams {
  discordGuildId: string
  lfgChannelId?: string
  recruiterRoleIds?: string[]
  timezone?: string
}

export async function updateGuildConfig(db: Db, params: UpdateGuildParams): Promise<Guild> {
  const { discordGuildId, ...changes } = params
  // Un serveur qui n'a jamais consommé de code d'invitation n'a pas de ligne
  // Guild : sans ce contrôle, Prisma lèverait une P2025 brute jusqu'à
  // l'utilisateur final plutôt que le message métier attendu.
  const existing = await db.guild.findUnique({ where: { discordGuildId } })
  if (!existing) throw new GuildNotOnboarded()
  return db.guild.update({
    where: { discordGuildId },
    // Reconfigurer un serveur le remet dans le circuit : c'est la façon dont un
    // admin corrige un salon supprimé sans repasser par un code d'invitation.
    data: { ...changes, status: 'ACTIVE', statusReason: null },
  })
}

export function listActiveGuilds(db: Db): Promise<Guild[]> {
  return db.guild.findMany({
    where: { status: 'ACTIVE', lfgChannelId: { not: null } },
    orderBy: { joinedAt: 'asc' },
  })
}

export async function markGuildNeedsAttention(db: Db, guildId: string, reason: string): Promise<void> {
  await db.guild.update({
    where: { id: guildId },
    data: { status: 'NEEDS_ATTENTION', statusReason: reason },
  })
}

export async function suspendGuild(db: Db, discordGuildId: string): Promise<void> {
  await db.guild.updateMany({
    where: { discordGuildId },
    data: { status: 'SUSPENDED', statusReason: 'bot retiré du serveur' },
  })
  await db.eventMessage.updateMany({ where: { guildId: discordGuildId }, data: { disabled: true } })
}
