import type { Interaction } from 'discord.js'
import type { Db } from '../db/client.js'
import type { DiscordGateway } from '../broadcast/gateway.js'
import type { EmojiMap } from '../config/emojis.js'
import { DomainError } from '../domain/errors.js'
import { logger } from '../logger.js'

export interface BotDeps {
  db: Db
  gateway: DiscordGateway
  emojis: EmojiMap
  ownerId: string
}

export interface HandlerContext {
  interaction: Interaction
  id: string
  deps: BotDeps
}

export type InteractionHandler = (ctx: HandlerContext) => Promise<void>

const PREFIX = 'pug'
const VERSION = '1'
const handlers = new Map<string, InteractionHandler>()

export function registerHandler(domain: string, action: string, handler: InteractionHandler): void {
  handlers.set(`${domain}:${action}`, handler)
}

/** Réservé aux tests : repart d'une table d'aiguillage vide. */
export function resetHandlers(): void {
  handlers.clear()
}

export function parseCustomId(customId: string): { domain: string; action: string; id: string } | null {
  const parts = customId.split(':')
  if (parts.length !== 5) return null
  const [prefix, version, domain, action, id] = parts as [string, string, string, string, string]
  if (prefix !== PREFIX || version !== VERSION) return null
  return { domain, action, id }
}

async function replyEphemeral(interaction: Interaction, content: string): Promise<void> {
  if (!('reply' in interaction)) return
  const target = interaction as unknown as {
    replied: boolean
    deferred: boolean
    reply: (o: unknown) => Promise<unknown>
    followUp: (o: unknown) => Promise<unknown>
  }
  const payload = { content, ephemeral: true }
  if (target.replied || target.deferred) await target.followUp(payload)
  else await target.reply(payload)
}

/**
 * Point d'entrée unique des composants. Le try/catch global est la garantie
 * qu'aucune interaction ne reste sans réponse : un bouton qui tourne dans le
 * vide est la pire manifestation possible d'un bug côté utilisateur.
 */
export async function dispatchInteraction(interaction: Interaction, deps: BotDeps): Promise<void> {
  if (!('customId' in interaction) || typeof interaction.customId !== 'string') return
  const parsed = parseCustomId(interaction.customId)
  if (!parsed) return // composant d'un autre bot ou format obsolète

  const handler = handlers.get(`${parsed.domain}:${parsed.action}`)
  if (!handler) return

  try {
    await handler({ interaction, id: parsed.id, deps })
  } catch (error) {
    if (error instanceof DomainError) {
      await replyEphemeral(interaction, error.userMessage)
      return
    }
    logger.error({ err: error, customId: interaction.customId }, 'handler en échec')
    await replyEphemeral(interaction, 'Something went wrong. The issue has been logged.')
  }
}
