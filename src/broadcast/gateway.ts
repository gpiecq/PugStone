export interface MessagePayload {
  content?: string
  embeds: unknown[]
  components: unknown[]
}

export interface DiscordGateway {
  sendMessage(channelId: string, payload: MessagePayload): Promise<{ messageId: string }>
  editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<void>
  sendDM(userId: string, payload: MessagePayload): Promise<{ channelId: string; messageId: string }>
  createPrivateThread(channelId: string, name: string, inviteUserId: string): Promise<{ channelId: string }>
}

export type FailureKind = 'TRANSIENT' | 'TARGET_UNUSABLE' | 'MESSAGE_GONE'

const TARGET_UNUSABLE_CODES = new Set([50001, 50013, 10003])

/**
 * Une erreur inconnue est délibérément classée transitoire : réessayer huit fois
 * pour rien est sans conséquence, alors qu'abandonner à tort perd une publication.
 */
export function classifyDiscordError(error: unknown): FailureKind {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'number') return 'TRANSIENT'
  if (TARGET_UNUSABLE_CODES.has(code)) return 'TARGET_UNUSABLE'
  if (code === 10008) return 'MESSAGE_GONE'
  return 'TRANSIENT'
}
