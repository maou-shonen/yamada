import type { Config } from '../config/index.ts'
import type { PlatformChannel, UnifiedMessage } from '../types.ts'
import { messagingApi, validateSignature } from '@line/bot-sdk'
import { log } from '../logger'
import { truncateText } from '../utils/text.ts'
import { ReplyTokenPool } from './reply-token-pool.ts'

const lineLog = log.withPrefix('[LINE]')

/** LINE Webhook 事件的型別定義（僅涵蓋需要處理的部分） */
interface LineMessageEvent {
  type: string
  replyToken: string
  source: {
    type: 'user' | 'group' | 'room'
    groupId?: string
    userId?: string
    roomId?: string
  }
  message: {
    type: string
    id: string
    text?: string
    mention?: {
      mentionees: Array<{
        type: string
        userId?: string
      }>
    }
  }
  timestamp: number
}

interface LineWebhookBody {
  events?: LineMessageEvent[]
}

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  image: '[圖片]',
  sticker: '[貼圖]',
  video: '[影片]',
  audio: '[音訊]',
  file: '[檔案]',
  location: '[位置]',
}

/**
 * LINE 平台通道
 *
 * WHY reply/push 雙策略：
 * - replyMessage：免費，但 replyToken 有 ~60 秒有效期，且只能用一次。
 * - pushMessage：隨時可用，但消耗 push 配額（有成本）。
 *
 * 我們優先使用 replyMessage（最大化免費額度），
 * 若 token 過期或失敗則 fallback 到 pushMessage（保證可靠性）。
 * 此策略在成本與可靠性之間取得平衡。
 *
 * Token 管理由 ReplyTokenPool 負責：
 * - 每個 webhook 事件到達時呼叫 pool.store() 存放 token
 * - sendMessage 呼叫 pool.claim() 取出最舊的有效 token（FIFO）
 * - pool 自動處理過期判斷與移除，channel 無需手動管理
 */
export class LineChannel implements PlatformChannel {
  readonly name = 'line'
  onMessage: (message: UnifiedMessage) => void = () => {}

  private config: Config
  private client: messagingApi.MessagingApiClient | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private readonly lineChannelAccessToken: string
  private readonly lineChannelSecret: string

  private pool: ReplyTokenPool

  constructor(config: Config, options?: { pool?: ReplyTokenPool }) {
    if (!config.LINE_CHANNEL_ACCESS_TOKEN || !config.LINE_CHANNEL_SECRET) {
      throw new Error('LineChannel 需要 LINE 憑證（LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET）')
    }
    this.config = config
    this.lineChannelAccessToken = config.LINE_CHANNEL_ACCESS_TOKEN
    this.lineChannelSecret = config.LINE_CHANNEL_SECRET
    this.pool = options?.pool ?? new ReplyTokenPool(config.DELIVERY_REPLY_TOKEN_FRESHNESS_MS)
  }

  async start(): Promise<void> {
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: this.lineChannelAccessToken,
    })

    this.server = Bun.serve({
      port: this.config.LINE_WEBHOOK_PORT,
      fetch: async req => this.handleRequest(req),
    })

    lineLog.withMetadata({ port: this.server.port }).info('Webhook server started')
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop()
      this.server = null
      lineLog.info('Webhook server stopped')
    }
    this.client = null
    this.pool.clear()
  }

  /**
   * 傳送訊息到指定群組
   *
   * WHY reply-first-then-push 策略：
   * LINE 對 push message 有配額限制（成本），但 reply 完全免費。
   * 我們從 pool 取出 replyToken 以最大化免費回覆的使用，
   * 只在 token 不存在或無效時才消耗 push 配額。
   */
  async sendMessage(groupId: string, content: string): Promise<void> {
    if (!this.client) {
      throw new Error('[LINE] Client 尚未初始化，請先呼叫 start()')
    }

    const truncated = truncateText(content, this.config.DELIVERY_LINE_MAX_LENGTH)

    const messages: messagingApi.TextMessage[] = [
      { type: 'text', text: truncated },
    ]

    // 嘗試從 pool 取出有效的 replyToken（pool 自動處理過期判斷）
    const token = this.pool.claim(groupId)
    if (token) {
      try {
        await this.client.replyMessage({ replyToken: token, messages })
        return
      }
      catch (error) {
        lineLog.withError(error).warn('replyMessage failed, falling back to pushMessage')
      }
    }

    // Fallback: pushMessage（有配額限制）
    try {
      await this.client.pushMessage({
        to: groupId,
        messages,
      })
      lineLog
        .withMetadata({ groupId })
        .warn('Using pushMessage (consumes push quota)')
    }
    catch (error) {
      lineLog.withError(error).error('pushMessage also failed')
      throw error
    }
  }

  /** LINE 平台不支援 reaction，記錄 log 後靜默回傳 */
  async sendReaction(
    groupId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    lineLog
      .withMetadata({ groupId, messageId, emoji })
      .warn('sendReaction not supported')
  }

  // ── 內部方法 ──────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (req.method !== 'POST' || url.pathname !== '/webhook/line') {
      return new Response('Not Found', { status: 404 })
    }

    const body = await req.text()
    const signature = req.headers.get('x-line-signature') ?? ''

    if (!signature || !validateSignature(body, this.lineChannelSecret, signature)) {
      lineLog.warn('Webhook signature verification failed')
      return new Response('Unauthorized', { status: 401 })
    }

    let events: LineMessageEvent[]
    try {
      const payload = JSON.parse(body) as LineWebhookBody
      events = (payload.events ?? []) as LineMessageEvent[]
    }
    catch {
      return new Response('Bad Request', { status: 400 })
    }

    // 非同步處理事件，不阻塞 webhook response
    for (const event of events) {
      this.handleEvent(event).catch(err =>
        lineLog.withError(err).error('Event handling error'),
      )
    }

    return new Response('OK', { status: 200 })
  }

  private async handleEvent(event: LineMessageEvent): Promise<void> {
    if (event.type !== 'message')
      return

    lineLog
      .withMetadata({
        eventType: event.type,
        sourceType: event.source.type,
        groupId: event.source.groupId || '(none)',
        userId: event.source.userId || '(none)',
        messageType: event.message.type,
      })
      .debug('Webhook event received')

    const sourceType = event.source.type

    if (sourceType === 'user') {
      await this.replyDmNotSupported(event.replyToken)
      return
    }

    if (sourceType !== 'group')
      return

    const groupId = event.source.groupId
    const userId = event.source.userId
    if (!groupId || !userId)
      return

    this.pool.store(groupId, event.replyToken)

    // 取得使用者名稱（嘗試 getGroupMemberProfile，失敗 fallback 到 userId）
    const userName = await this.resolveUserName(groupId, userId)

    const content = this.resolveMessageContent(event.message)

    const isMention = this.checkIsMention(event.message)

    const unifiedMessage: UnifiedMessage = {
      id: event.message.id,
      groupId,
      userId,
      userName,
      content,
      timestamp: new Date(event.timestamp),
      platform: 'line',
      isBot: false, // LINE webhook 不會送 bot 自己的訊息
      isMention,
      raw: event,
    }

    this.onMessage(unifiedMessage)
  }

  private async replyDmNotSupported(replyToken: string): Promise<void> {
    if (!this.client)
      return

    try {
      await this.client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: this.config.DELIVERY_DM_REPLY_TEXT }],
      })
    }
    catch (error) {
      lineLog
        .withError(error)
        .warn('Failed to reply DM not supported message')
    }
  }

  private async resolveUserName(
    groupId: string,
    userId: string,
  ): Promise<string> {
    if (!this.client)
      return userId

    try {
      const profile = await this.client.getGroupMemberProfile(groupId, userId)
      return profile.displayName || userId
    }
    catch {
      return userId
    }
  }

  private resolveMessageContent(message: LineMessageEvent['message']): string {
    if (message.type === 'text') {
      return message.text ?? ''
    }

    return MESSAGE_TYPE_LABELS[message.type] ?? `[${message.type}]`
  }

  private checkIsMention(message: LineMessageEvent['message']): boolean {
    // Caveat：LINE 的 mention API 無法可靠地暴露 bot 自己的 userId 用於比對。
    // 我們採用保守策略：任何 mention 都視為 bot mention（假正例可接受，
    // 因為急迫模式只是縮短 debounce 延遲，不會造成功能錯誤）。
    if (!message.mention?.mentionees)
      return false
    return message.mention.mentionees.length > 0
  }
}
