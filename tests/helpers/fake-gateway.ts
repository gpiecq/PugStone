import type { DiscordGateway, MessagePayload } from '../../src/broadcast/gateway.js'

export function discordError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Discord error ${code}`), { code })
}

export type GatewayMethod = 'sendMessage' | 'editMessage' | 'sendDM' | 'createPrivateThread' | 'fetchGuildOwnerId'

export class FakeGateway implements DiscordGateway {
  sent: { channelId: string; messageId: string; payload: MessagePayload }[] = []
  edited: { channelId: string; messageId: string; payload: MessagePayload }[] = []
  dms: { userId: string; payload: MessagePayload }[] = []
  threads: { channelId: string; name: string; inviteUserId: string }[] = []
  guildOwnerFetches: string[] = []
  /** Permet à un test de fixer l'owner d'une guilde précise ; sinon un id déterministe `owner-<discordGuildId>`. */
  guildOwners: Record<string, string> = {}

  private queued: unknown[] = []
  private permanent: unknown
  private queuedByMethod: Partial<Record<GatewayMethod, unknown[]>> = {}

  /** Fait échouer les N prochains appels, dans l'ordre, tous types confondus. */
  failNext(...errors: unknown[]): void {
    this.queued.push(...errors)
  }
  failAlways(error: unknown): void {
    this.permanent = error
  }
  /**
   * Fait échouer les N prochains appels d'une méthode précise, sans affecter
   * les autres. Utile quand plusieurs lignes sont traitées en parallèle (le
   * worker n'impose aucun ordre entre elles) et que le test vise un appel
   * Discord précis plutôt que "le premier appel, quel qu'il soit" — la file
   * ciblée est consultée avant la file générique de `failNext`.
   */
  failNextOn(method: GatewayMethod, ...errors: unknown[]): void {
    const list = this.queuedByMethod[method] ?? []
    list.push(...errors)
    this.queuedByMethod[method] = list
  }

  private check(method: GatewayMethod): void {
    const targeted = this.queuedByMethod[method]
    const next = targeted?.shift() ?? this.queued.shift() ?? this.permanent
    if (next) throw next
  }

  private nextId = 0
  private id(): string {
    return `m${++this.nextId}`
  }

  async sendMessage(channelId: string, payload: MessagePayload) {
    this.check('sendMessage')
    const messageId = this.id()
    this.sent.push({ channelId, messageId, payload })
    return { messageId }
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload) {
    this.check('editMessage')
    this.edited.push({ channelId, messageId, payload })
  }

  async sendDM(userId: string, payload: MessagePayload) {
    this.check('sendDM')
    this.dms.push({ userId, payload })
    return { channelId: `dm-${userId}`, messageId: this.id() }
  }

  async createPrivateThread(channelId: string, name: string, inviteUserId: string) {
    this.check('createPrivateThread')
    this.threads.push({ channelId, name, inviteUserId })
    return { channelId: `thread-${channelId}` }
  }

  async fetchGuildOwnerId(discordGuildId: string) {
    this.check('fetchGuildOwnerId')
    this.guildOwnerFetches.push(discordGuildId)
    return this.guildOwners[discordGuildId] ?? `owner-${discordGuildId}`
  }
}
