import type { DiscordGateway, MessagePayload } from '../../src/broadcast/gateway.js'

export function discordError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Discord error ${code}`), { code })
}

export class FakeGateway implements DiscordGateway {
  sent: { channelId: string; messageId: string; payload: MessagePayload }[] = []
  edited: { channelId: string; messageId: string; payload: MessagePayload }[] = []
  dms: { userId: string; payload: MessagePayload }[] = []
  threads: { channelId: string; name: string; inviteUserId: string }[] = []

  private queued: unknown[] = []
  private permanent: unknown

  /** Fait échouer les N prochains appels, dans l'ordre. */
  failNext(...errors: unknown[]): void {
    this.queued.push(...errors)
  }
  failAlways(error: unknown): void {
    this.permanent = error
  }

  private check(): void {
    const next = this.queued.shift() ?? this.permanent
    if (next) throw next
  }

  private nextId = 0
  private id(): string {
    return `m${++this.nextId}`
  }

  async sendMessage(channelId: string, payload: MessagePayload) {
    this.check()
    const messageId = this.id()
    this.sent.push({ channelId, messageId, payload })
    return { messageId }
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload) {
    this.check()
    this.edited.push({ channelId, messageId, payload })
  }

  async sendDM(userId: string, payload: MessagePayload) {
    this.check()
    this.dms.push({ userId, payload })
    return { channelId: `dm-${userId}`, messageId: this.id() }
  }

  async createPrivateThread(channelId: string, name: string, inviteUserId: string) {
    this.check()
    this.threads.push({ channelId, name, inviteUserId })
    return { channelId: `thread-${channelId}` }
  }
}
