import type { Database } from 'bun:sqlite'
import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { PlatformChannel, UnifiedMessage } from '../types'
import { assembleContext } from '../lib/context'
import { deliverReaction, deliverReply } from '../lib/delivery'
import { generateReply } from '../lib/generator'
import { runObserver } from '../lib/observer'
import { log } from '../logger'
import { processNewMessages } from '../storage/embedding'
import { getRecentMessages, saveBotMessage, saveMessage } from '../storage/messages'

export interface AgentServices {
  saveMessage: typeof saveMessage
  saveBotMessage: typeof saveBotMessage
  getRecentMessages: typeof getRecentMessages
  assembleContext: typeof assembleContext
  generateReply: typeof generateReply
  deliverReply: typeof deliverReply
  deliverReaction: typeof deliverReaction
  runObserver: typeof runObserver
  processNewMessages: typeof processNewMessages
}

const defaultServices: AgentServices = {
  saveMessage,
  saveBotMessage,
  getRecentMessages,
  assembleContext,
  generateReply,
  deliverReply,
  deliverReaction,
  runObserver,
  processNewMessages,
}

export interface AgentOptions {
  groupId: string
  config: Config
  db: DB
  sqliteDb: Database
  channels: Map<string, PlatformChannel>
  services?: AgentServices
}

/**
 * 每個群組的 AI 代理
 * WHY：每個群組需要獨立的 Agent 以隔離處理狀態
 * 這樣不同群組的訊息不會互相干擾
 *
 * 觸發時機由外部排程器（Scheduler）決定，Agent 本身不做 debounce
 */
export class Agent {
  private readonly groupId: string
  private readonly config: Config
  private readonly db: DB
  private readonly sqliteDb: Database
  private readonly channels: Map<string, PlatformChannel>
  private readonly services: AgentServices
  private readonly log: ReturnType<typeof log.withPrefix>

  // 追蹤 in-flight pipeline，供 shutdown 等待
  private inFlightPipeline: Promise<void> | null = null

  constructor(options: AgentOptions) {
    this.groupId = options.groupId
    this.config = options.config
    this.db = options.db
    this.sqliteDb = options.sqliteDb
    this.channels = options.channels
    this.services = options.services ?? defaultServices
    this.log = log.withPrefix(`[Agent][${options.groupId}]`)
  }

  /**
   * 接收訊息，只做儲存（不觸發 AI pipeline）
   * 觸發時機由外部排程器決定
   */
  receiveMessage(message: UnifiedMessage): void {
    this.log
      .withMetadata({
        messageId: message.id,
        userId: message.userId,
        userName: message.userName,
        platform: message.platform,
        contentPreview: message.content.slice(0, 80),
        isMention: message.isMention,
      })
      .info('Received message')

    this.services.saveMessage(this.db, message)
  }

  /**
   * 由排程器呼叫，執行完整的 AI 回覆 pipeline。
   * 從 DB 取出近期訊息，組裝 context，生成回覆，投遞。
   *
   * @param platform - 'discord' | 'line'
   */
  async processTriggeredMessages(platform: 'discord' | 'line'): Promise<void> {
    const startTime = Date.now()

    this.log
      .withMetadata({ platform })
      .info('Starting AI pipeline')

    const pipeline = this.runPipeline(platform, startTime)
    this.inFlightPipeline = pipeline
    try {
      await pipeline
    }
    finally {
      this.inFlightPipeline = null
    }
  }

  async shutdown(): Promise<void> {
    // 等待 in-flight AI pipeline 完成，防止半途中斷的回覆
    if (this.inFlightPipeline) {
      const shutdownTimeoutMs = this.config.SHUTDOWN_TIMEOUT_MS
      const result = await Promise.race([
        this.inFlightPipeline.then(() => 'done' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), shutdownTimeoutMs)),
      ])
      if (result === 'timeout') {
        this.log.warn('Shutdown timeout: in-flight pipeline did not complete in time')
      }
    }
  }

  /**
   * 執行完整 AI pipeline：getRecentMessages → assembleContext → generateReply → delivery → observer → embedding
   */
  private async runPipeline(platform: 'discord' | 'line', startTime: number): Promise<void> {
    const recentMessages = this.services.getRecentMessages(this.db, this.config.CONTEXT_RECENT_MESSAGE_COUNT)
    this.log.withMetadata({ recentCount: recentMessages.length }).debug('Fetched recent messages')

    this.log.debug('Assembling context...')
    const contextMessages = await this.services.assembleContext({
      recentMessages,
      config: this.config,
      db: this.db,
      sqliteDb: this.sqliteDb,
    })
    this.log.withMetadata({ contextMessageCount: contextMessages.length }).debug('Context assembled')

    this.log.info('Calling LLM API...')
    const llmStart = Date.now()
    const { actions, usage } = await this.services.generateReply(contextMessages, this.config)
    const llmDuration = Date.now() - llmStart
    this.log
      .withMetadata({
        llmDurationMs: llmDuration,
        actionCount: actions.length,
        actionTypes: actions.map(a => a.type),
      })
      .info('LLM response received')

    // 根據 AI 的 tool 決策執行對應動作
    const channel = this.channels.get(platform)
    // 取最後一則訊息的 externalId 作為 reaction target
    const lastMessage = recentMessages[recentMessages.length - 1]
    const lastMessageId = lastMessage?.externalId ?? undefined

    for (const action of actions) {
      switch (action.type) {
        case 'reply': {
          if (channel) {
            this.log.withMetadata({ platform }).debug('Delivering reply...')
            await this.services.deliverReply({
              channel,
              groupId: this.groupId,
              content: action.content,
              platform,
              config: this.config,
            })
            this.log.withMetadata({ platform }).info('Reply delivered')
          }
          else {
            this.log.withMetadata({ platform }).warn('No channel found for platform, skipping delivery')
          }

          this.services.saveBotMessage(this.db, action.content, this.config.BOT_USER_ID)
          break
        }
        case 'reaction': {
          if (channel && lastMessageId) {
            this.log.withMetadata({ platform, emoji: action.emoji }).debug('Delivering reaction...')
            await this.services.deliverReaction({
              channel,
              groupId: this.groupId,
              messageId: lastMessageId,
              emoji: action.emoji,
            })
            this.log.withMetadata({ platform, emoji: action.emoji }).info('Reaction delivered')
          }
          break
        }
        case 'skip': {
          this.log
            .withMetadata({ reason: action.reason })
            .info('AI decided to skip this conversation')
          break
        }
      }
    }

    void usage

    // WHY fire-and-forget：記憶壓縮是 best-effort；失敗表示摘要過時但不影響當前回覆
    this.log.debug('Triggering Observer (background)...')
    this.services.runObserver(this.db, this.config).catch((err) => {
      this.log.withError(err).error('Observer error')
    })

    // WHY fire-and-forget：向量索引降級可接受，回覆投遞不能失敗
    if (this.config.embeddingEnabled) {
      this.log.debug('Triggering Embedding (background)...')
      this.services.processNewMessages(this.sqliteDb, recentMessages, this.config).catch((err) => {
        this.log.withError(err).error('Embedding error')
      })
    }

    const totalDuration = Date.now() - startTime
    this.log
      .withMetadata({ totalDurationMs: totalDuration, llmDurationMs: llmDuration })
      .info('AI pipeline completed')
  }
}
