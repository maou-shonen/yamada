import type { AgentServices } from './agent/index'
import type { Config } from './config/index.ts'
import type { Scheduler } from './scheduler/index'
import type { AppDb } from './storage/db'
import type { PlatformChannel, UnifiedMessage } from './types'
import { Agent } from './agent/index'
import { log } from './logger'
import { createScheduler as defaultCreateScheduler } from './scheduler/index'
import { upsertTrigger } from './scheduler/trigger-store'
import { closeDb, openDb } from './storage/db'
import { SqliteVectorStore } from './storage/sqlite-vector-store'

const routerLog = log.withPrefix('[Router]')

/** bootstrap 回傳的共用資源，供各入口點使用 */
export interface AppContext {
  config: Config
  appDb: AppDb
  channels: Map<string, PlatformChannel>
  groupAgents: Map<string, Agent>
  /** 將 channel 註冊到 router 並啟動 */
  startChannels: (activeChannels: PlatformChannel[]) => Promise<void>
  /** Graceful shutdown：停止 channels → scheduler → agents → 關閉 DB */
  shutdown: (activeChannels: PlatformChannel[]) => Promise<void>
  /** Health server（當 LINE 未啟用時） */
  healthServer?: ReturnType<typeof Bun.serve>
}

/** 可注入的選項（測試時用 mock 替換） */
export interface BootstrapOptions {
  /** 測試時可指定 temp DB 路徑 */
  dbPath?: string
  /** 測試時注入 fake scheduler factory */
  createScheduler?: typeof defaultCreateScheduler
  /** 測試時注入 mock agent services（AI、storage 等） */
  agentServices?: AgentServices
}

/**
 * 應用程式共用 bootstrap 流程
 *
 * 目的：允許 Discord-only、LINE-only 或雙平台入口點共享同一初始化序列，避免重複程式碼。
 * 不包含平台 channel 的建立與啟動，由各入口點自行處理。
 *
 * 初始化順序：single DB → scheduler
 * 關閉順序：channels → scheduler → agents → DB
 */
export async function bootstrap(config: Config, options?: BootstrapOptions): Promise<AppContext> {
  const dbPath = options?.dbPath ?? config.DB_PATH
  log.withMetadata({ dbPath }).info('Opening app database...')
  const appDb = openDb(dbPath, config.EMBEDDING_DIMENSIONS)
  const vectorStore = new SqliteVectorStore(appDb.sqlite)

  const channels = new Map<string, PlatformChannel>()
  const groupAgents = new Map<string, Agent>()
  let healthServer: ReturnType<typeof Bun.serve> | undefined

  // 建立排程器（負責 debounce trigger 輪詢 + AI pipeline 觸發）
  const schedulerFactory = options?.createScheduler ?? defaultCreateScheduler
  const scheduler: Scheduler = schedulerFactory({
    sqlite: appDb.sqlite,
    getAgent: (groupId: string) => groupAgents.get(groupId),
    config,
  })

  function createAgent(groupId: string): Agent {
    const agent = new Agent({
      groupId,
      config,
      db: appDb.db,
      vectorStore,
      channels,
      services: options?.agentServices,
    })
    groupAgents.set(groupId, agent)
    return agent
  }

  /**
   * 訊息路由：per-group Agent lookup + lazy creation
   *
   * 過濾邏輯（bot、self、DM）由各平台 channel 層負責，
   * 此處僅處理群組路由，避免與 channel 層重複。
   */
  function handleMessage(message: UnifiedMessage): void {
    routerLog
      .withMetadata({
        platform: message.platform,
        groupId: message.groupId || '(DM)',
        userId: message.userId,
        userName: message.userName,
        contentLength: message.content.length,
      })
      .info('Incoming message')

    let agent = groupAgents.get(message.groupId)
    if (!agent) {
      routerLog.withMetadata({ groupId: message.groupId, platform: message.platform }).info('Creating new Agent')
      agent = createAgent(message.groupId)
    }

    agent.receiveMessage(message)

    // 寫入 debounce trigger（排程器會輪詢 DB 決定何時觸發 AI pipeline）
    upsertTrigger(appDb.sqlite, message.groupId, message.platform, message.isMention, message.content.length, config)
  }

  // startChannels：先註冊 channels 並綁定 onMessage，再啟動，最後啟動排程器
  // 約束：onMessage 必須在 start() 前綁定，避免平台在啟動時發送早期訊息而遺漏
  async function startChannels(activeChannels: PlatformChannel[]): Promise<void> {
    for (const channel of activeChannels) {
      channels.set(channel.name, channel)
      channel.onMessage = message => handleMessage(message)
    }

    log.withMetadata({ platforms: activeChannels.map(ch => ch.name) }).info('Starting platform channels...')
    await Promise.all(activeChannels.map(ch => ch.start()))

    // 若 LINE 未啟用，啟動獨立的 health server
    if (!config.lineEnabled) {
      healthServer = Bun.serve({
        port: config.HEALTH_PORT,
        fetch: (req) => {
          const url = new URL(req.url)
          if (req.method === 'GET' && url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response('Not Found', { status: 404 })
        },
      })
      log.withMetadata({ port: config.HEALTH_PORT }).info('Health server started')
    }

    // Channels 就緒後才啟動排程器，確保觸發時 channel 已可投送
    scheduler.start()
    log.info('Scheduler started')
  }

  // shutdown：完整優雅關閉順序
  // 1. 停止接收新訊息（channels）
  // 2. 停止排程器（等待 in-flight tick 完成）
  // 3. 等待 in-flight AI pipeline 完成（agents）
  // 4. 關閉 DB
  // 約束：使用 allSettled 而非 all，一個平台失敗不應阻止其他平台清理
  // 注意：不在此處呼叫 process.exit()，由入口點決定是否需要強制退出
  async function shutdown(activeChannels: PlatformChannel[]): Promise<void> {
    log.info('Shutting down yamada...')

    // 1. 停止接收新訊息
    await Promise.allSettled(activeChannels.map(ch => ch.stop()))

    // 2. 停止排程器（等待 in-flight tick）
    await scheduler.stop()

    // 3. 等待 in-flight AI pipeline
    await Promise.allSettled(
      [...groupAgents.values()].map(agent => agent.shutdown()),
    )

    // 4. 關閉 DB
    closeDb(appDb)

    log.info('yamada shutdown complete')

    // 5. 停止 health server（當 LINE 未啟用時）
    if (healthServer) {
      healthServer.stop()
      healthServer = undefined
      log.info('Health server stopped')
    }
  }

  return { config, appDb, channels, groupAgents, startChannels, shutdown, healthServer }
}
