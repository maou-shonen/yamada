import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { VectorStore } from '../storage/vector-store'
import type { PlatformChannel, StoredImage, UnifiedMessage } from '../types'
import { Buffer } from 'node:buffer'
import { and, desc, eq } from 'drizzle-orm'
import { replaceAliasesWithNames } from '../lib/alias-replacer'
import { assembleContext } from '../lib/context'
import { deliverReaction, deliverReply } from '../lib/delivery'
import { processNewChunks } from '../lib/embedding'
import { generateReply } from '../lib/generator'
import { downloadImage, resizeImage } from '../lib/image'
import { runObserver } from '../lib/observer'
import { generateImageDescription, analyzeImage as visionAnalyzeImage } from '../lib/vision'
import { log } from '../logger'
import { getFrequencyState, saveFrequencyState } from '../storage/frequency-stats'
import { saveImage, getImageById as storageGetImageById, updateImageDescription } from '../storage/images'
import { getRecentMessages, saveBotMessage, saveMessage } from '../storage/messages'
import * as schema from '../storage/schema'
import { getAliasMap, getOrCreateAlias } from '../storage/user-aliases'
import { recordActivity } from '../storage/user-stats'
import { containsUrl, STICKER_CONTENT } from '../utils'
import { checkFrequency } from './frequency-controller'
import { calculateDecay, updateEma } from './frequency-math'

export interface AgentServices {
  saveMessage: typeof saveMessage
  saveBotMessage: typeof saveBotMessage
  getRecentMessages: typeof getRecentMessages
  assembleContext: typeof assembleContext
  generateReply: typeof generateReply
  deliverReply: typeof deliverReply
  deliverReaction: typeof deliverReaction
  runObserver: (db: DB, groupId: string, vectorStore: VectorStore, config: Config) => Promise<void>
  processNewChunks: typeof processNewChunks
  recordActivity: typeof recordActivity
  checkFrequency: typeof checkFrequency
  analyzeImage: (thumbnail: Buffer, question: string, config: Config) => Promise<string>
  getImageById: (db: DB, groupId: string, id: number) => StoredImage | null
  getOrCreateAlias: (db: DB, groupId: string, userId: string, userName: string) => Promise<{ alias: string, userName: string }>
  getAliasMap: (db: DB, groupId: string, userIds: string[]) => Promise<Map<string, { alias: string, userName: string }>>
  processImages?: (message: UnifiedMessage, db: DB, groupId: string, config: Config) => Promise<void>
  downloadLineImage?: (platformImageId: string) => Promise<Buffer>
}

async function defaultDownloadLineImage(): Promise<Buffer> {
  throw new Error('LINE image download not configured')
}

const imageProcessLog = log.withPrefix('[Agent][Image]')

async function defaultProcessImages(
  message: UnifiedMessage,
  db: DB,
  groupId: string,
  config: Config,
  downloadLineImage: (platformImageId: string) => Promise<Buffer>,
): Promise<void> {
  if (!message.images?.length)
    return

  const storedMessage = db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.groupId, groupId), eq(schema.messages.externalId, message.id)))
    .orderBy(desc(schema.messages.id))
    .get()

  if (!storedMessage)
    throw new Error(`Saved message not found for externalId=${message.id}`)

  for (const attachment of message.images) {
    try {
      let originalBuffer: Buffer

      if (attachment.url) {
        originalBuffer = await downloadImage(attachment.url, config.IMAGE_MAX_DOWNLOAD_SIZE_MB)
      }
      else if (attachment.platformImageId) {
        originalBuffer = await downloadLineImage(attachment.platformImageId)
      }
      else {
        throw new Error('Image attachment missing url/platformImageId')
      }

      const resized = await resizeImage(
        originalBuffer,
        config.IMAGE_MAX_DIMENSION,
        config.IMAGE_QUALITY,
      )

      const imageId = saveImage(db, groupId, {
        messageId: storedMessage.id,
        thumbnail: resized.buffer,
        mimeType: resized.mimeType,
        width: resized.width,
        height: resized.height,
      })

      const description = await generateImageDescription(resized.buffer, config)
      updateImageDescription(db, imageId, description)
    }
    catch (error) {
      imageProcessLog.withError(error).warn('Image processing failed for one attachment')
    }
  }
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
  processNewChunks,
  recordActivity,
  checkFrequency,
  analyzeImage: (thumbnail, question, config) => visionAnalyzeImage(thumbnail, question, config),
  getImageById: storageGetImageById,
  getOrCreateAlias,
  getAliasMap,
  downloadLineImage: defaultDownloadLineImage,
  processImages(message, db, groupId, config) {
    return defaultProcessImages(message, db, groupId, config, this.downloadLineImage ?? defaultDownloadLineImage)
  },
}

export interface AgentOptions {
  groupId: string
  config: Config
  db: DB
  vectorStore: VectorStore
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
  private readonly vectorStore: VectorStore
  private readonly channels: Map<string, PlatformChannel>
  private readonly services: AgentServices
  private readonly log: ReturnType<typeof log.withPrefix>

  // 追蹤 in-flight pipeline，供 shutdown 等待
  private inFlightPipeline: Promise<void> | null = null

  constructor(options: AgentOptions) {
    this.groupId = options.groupId
    this.config = options.config
    this.db = options.db
    this.vectorStore = options.vectorStore
    this.channels = options.channels
    this.services = options.services ?? defaultServices
    this.log = log.withPrefix(`[Agent][${options.groupId}]`)
  }

  /**
   * 接收訊息，只做儲存（不觸發 AI pipeline）
   * 觸發時機由外部排程器決定
   */
  async receiveMessage(message: UnifiedMessage): Promise<void> {
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

    this.services.saveMessage(this.db, this.groupId, message)

    if (message.images?.length && this.config.visionEnabled && this.services.processImages) {
      this.services.processImages(message, this.db, this.groupId, this.config).catch((err) => {
        this.log.withError(err).warn('Image processing failed')
      })
    }

    // Alias upsert：每次收到訊息時更新 alias（追蹤用戶改名）
    try {
      await this.services.getOrCreateAlias(this.db, this.groupId, message.userId, message.userName)
    }
    catch (error) {
      this.log.withError(error).warn('Alias upsert 失敗，繼續處理')
    }

    // 記錄用戶活動統計
    try {
      const date = new Date().toISOString().slice(0, 10) // UTC YYYY-MM-DD
      const isSticker = message.content === STICKER_CONTENT
      const hasUrl = containsUrl(message.content)
      this.services.recordActivity(this.db, this.groupId, {
        userId: message.userId,
        date,
        isSticker,
        hasUrl,
        isMention: message.isMention,
      })
    }
    catch (error) {
      this.log.withError(error).warn('記錄用戶活動統計失敗')
    }
  }

  /**
   * 由排程器呼叫，執行完整的 AI 回覆 pipeline。
   * 從 DB 取出近期訊息，組裝 context，生成回覆，投遞。
   *
   * @param platform - 'discord' | 'line'
   * @param isMention - 本次 trigger 批次是否包含 mention
   */
  async processTriggeredMessages(platform: 'discord' | 'line', isMention: boolean): Promise<void> {
    const startTime = Date.now()

    this.log
      .withMetadata({ platform, isMention })
      .info('Starting AI pipeline')

    const pipeline = this.runPipeline(platform, startTime, isMention)
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
  private async runPipeline(platform: 'discord' | 'line', startTime: number, isMention: boolean): Promise<void> {
    // 頻率控制：在 LLM pipeline 之前決定是否回應
    const decision = this.services.checkFrequency(this.db, this.groupId, this.config, isMention)
    if (!decision.shouldRespond) {
      this.log
        .withMetadata(decision.metadata)
        .info('Frequency controller: skipping response')
      return
    }

    const recentMessages = this.services.getRecentMessages(this.db, this.groupId, this.config.CONTEXT_RECENT_MESSAGE_COUNT)
    this.log.withMetadata({ recentCount: recentMessages.length }).debug('Fetched recent messages')

    // 查詢 alias map（用於 context 組裝和回覆後處理）
    const nonBotUserIds = [...new Set(recentMessages.filter(m => !m.isBot).map(m => m.userId))]
    const aliasMap = await this.services.getAliasMap(this.db, this.groupId, nonBotUserIds)
    const reverseMap = new Map([...aliasMap.entries()].map(([, { alias, userName }]) => [alias, userName]))

    this.log.debug('Assembling context...')
    const contextMessages = await this.services.assembleContext({
      recentMessages,
      config: this.config,
      db: this.db,
      groupId: this.groupId,
      vectorStore: this.vectorStore,
    })
    this.log.withMetadata({ contextMessageCount: contextMessages.length }).debug('Context assembled')

    this.log.info('Calling LLM API...')
    const llmStart = Date.now()
    const { actions, usage } = await this.services.generateReply(contextMessages, this.config, undefined, this.groupId)
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
          // 回覆後處理：alias → userName（用戶看到真實名稱）
          const processedContent = replaceAliasesWithNames(action.content, reverseMap)
          if (channel) {
            this.log.withMetadata({ platform }).debug('Delivering reply...')
            await this.services.deliverReply({
              channel,
              groupId: this.groupId,
              content: processedContent,
              platform,
              config: this.config,
            })
            this.log.withMetadata({ platform }).info('Reply delivered')
          }
          else {
            this.log.withMetadata({ platform }).warn('No channel found for platform, skipping delivery')
          }

          this.services.saveBotMessage(this.db, this.groupId, action.content, this.config.BOT_USER_ID)

          // EMA 回饋：bot 實際發送 reply 時更新頻率狀態
          try {
            const now = Date.now()
            const currentState = getFrequencyState(this.db, this.groupId)
            const elapsed = currentState ? now - currentState.lastUpdatedAt : 0
            const decayLong = elapsed > 0
              ? calculateDecay(elapsed, this.config.FREQUENCY_LONG_HALFLIFE_HOURS * 60 * 60 * 1000)
              : 0
            const decayShort = elapsed > 0
              ? calculateDecay(elapsed, this.config.FREQUENCY_SHORT_HALFLIFE_HOURS * 60 * 60 * 1000)
              : 0

            saveFrequencyState(this.db, this.groupId, {
              emaLongBot: updateEma(currentState?.emaLongBot ?? 0, 1, decayLong),
              emaLongTotal: updateEma(currentState?.emaLongTotal ?? 0, 1, decayLong),
              emaShortBot: updateEma(currentState?.emaShortBot ?? 0, 1, decayShort),
              emaShortTotal: updateEma(currentState?.emaShortTotal ?? 0, 1, decayShort),
              lastUpdatedAt: now,
            })
          }
          catch (error) {
            this.log.withError(error).warn('EMA 狀態更新失敗')
          }

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
        case 'viewImage': {
          const storedImage = this.services.getImageById(this.db, this.groupId, action.imageId)
          if (!storedImage) {
            this.log.withMetadata({ imageId: action.imageId }).warn('viewImage: image not found')
            break
          }
          try {
            const analysis = await this.services.analyzeImage(
              Buffer.from(storedImage.thumbnail),
              action.question ?? '',
              this.config,
            )
            if (channel) {
              await this.services.deliverReply({
                channel,
                groupId: this.groupId,
                content: analysis,
                platform,
                config: this.config,
              })
            }

            this.services.saveBotMessage(this.db, this.groupId, analysis, this.config.BOT_USER_ID)
          }
          catch (err) {
            this.log.withError(err).warn('viewImage analysis failed')
          }
          break
        }
      }
    }

    void usage

    // WHY fire-and-forget：記憶壓縮是 best-effort；失敗表示摘要過時但不影響當前回覆
    this.log.debug('Triggering Observer (background)...')
    this.services.runObserver(this.db, this.groupId, this.vectorStore, this.config).catch((err) => {
      this.log.withError(err).error('Observer error')
    })

    // WHY fire-and-forget：向量索引降級可接受，回覆投遞不能失敗
    if (this.config.embeddingEnabled) {
      this.log.debug('Triggering Embedding (background)...')
      this.services.processNewChunks(this.vectorStore, this.db, this.groupId, this.config).catch((err) => {
        this.log.withError(err).error('Embedding error')
      })
    }

    const totalDuration = Date.now() - startTime
    this.log
      .withMetadata({ totalDurationMs: totalDuration, llmDurationMs: llmDuration, isMention })
      .info('AI pipeline completed')
  }
}
