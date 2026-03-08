import type { Scheduler, SchedulerDeps } from '../../scheduler/index'
import type { PlatformChannel, UnifiedMessage } from '../../types'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { bootstrap } from '../../bootstrap'
import { createTestConfig } from '../helpers/config'

// 設定必要環境變數（避免 loadConfig Zod 驗證失敗）
Object.assign(process.env, {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
})

// ── Helpers ──

/** 產生唯一 temp 目錄路徑 */
function makeTempDir(): string {
  const dir = path.join('/tmp', `yamada-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeFakeChannel(name: string): PlatformChannel {
  return {
    name,
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    sendMessage: mock(() => Promise.resolve()),
    sendReaction: mock(() => Promise.resolve()),
    onMessage: (_msg: UnifiedMessage) => {},
  }
}

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    groupId: overrides.groupId ?? 'test-group',
    userId: overrides.userId ?? 'user-1',
    userName: overrides.userName ?? 'Alice',
    content: overrides.content ?? '你好呀',
    timestamp: overrides.timestamp ?? new Date(),
    platform: overrides.platform ?? 'discord',
    isBot: overrides.isBot ?? false,
    isMention: overrides.isMention ?? false,
  }
}

function makeTestConfig(overrides: Parameters<typeof createTestConfig>[0] = {}) {
  return createTestConfig({
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: 'test-client-id',
    discordEnabled: true,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    lineEnabled: true,
    LINE_WEBHOOK_PORT: 3000,
    embeddingEnabled: false,
    ...overrides,
  })
}

/** 建立可追蹤呼叫順序的 fake scheduler factory */
function makeFakeSchedulerFactory(callOrder: string[]) {
  const startMock = mock(() => { callOrder.push('scheduler.start') })
  const stopMock = mock(() => {
    callOrder.push('scheduler.stop')
    return Promise.resolve()
  })

  const factory = mock((_deps: SchedulerDeps): Scheduler => ({
    start: startMock,
    stop: stopMock,
  }))

  return { factory, startMock, stopMock }
}

// ── 測試 ──

describe('Bootstrap 整合測試', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    tempDirs.length = 0
  })

  test('bootstrap() 成功初始化並回傳 AppContext', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const callOrder: string[] = []
    const { factory } = makeFakeSchedulerFactory(callOrder)
    const config = makeTestConfig()

    const ctx = await bootstrap(config, {
      dbPath,
      createScheduler: factory,
    })

    expect(ctx.config).toBe(config)
    expect(ctx.appDb).toBeDefined()
    expect(ctx.channels).toBeInstanceOf(Map)
    expect(ctx.groupAgents).toBeInstanceOf(Map)
    expect(typeof ctx.startChannels).toBe('function')
    expect(typeof ctx.shutdown).toBe('function')

    // scheduler factory 應該被呼叫一次
    expect(factory).toHaveBeenCalledTimes(1)

    // DB 檔案應被建立
    expect(existsSync(dbPath)).toBe(true)

    // 清理
    await ctx.shutdown([])
  })

  test('handleMessage() 呼叫 agent.receiveMessage() 並寫入 DB trigger', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const callOrder: string[] = []
    const { factory } = makeFakeSchedulerFactory(callOrder)
    const config = makeTestConfig()

    const ctx = await bootstrap(config, {
      dbPath,
      createScheduler: factory,
    })

    const channel = makeFakeChannel('discord')
    await ctx.startChannels([channel])

    // 透過 channel.onMessage 發送訊息（模擬平台訊息進入）
    const msg = makeMessage({ groupId: 'group-abc', content: '測試訊息' })
    channel.onMessage(msg)

    // Agent 應被 lazy 建立
    expect(ctx.groupAgents.has('group-abc')).toBe(true)

    // 驗證 DB 中有 trigger 記錄
    const sqlite = new Database(dbPath, { readonly: true })
    const row = sqlite.query('SELECT * FROM pending_triggers WHERE group_id = ?').get('group-abc') as Record<string, unknown> | null
    sqlite.close()

    expect(row).not.toBeNull()
    expect(row!.group_id).toBe('group-abc')
    expect(row!.platform).toBe('discord')
    expect(row!.status).toBe('pending')

    await ctx.shutdown([channel])
  })

  test('startChannels() 啟動 channels 並啟動 scheduler', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const callOrder: string[] = []
    const { factory, startMock } = makeFakeSchedulerFactory(callOrder)
    const config = makeTestConfig()

    const ctx = await bootstrap(config, {
      dbPath,
      createScheduler: factory,
    })

    const ch1 = makeFakeChannel('discord')
    const ch2 = makeFakeChannel('line')

    await ctx.startChannels([ch1, ch2])

    // 兩個 channel 的 start() 都應被呼叫
    expect(ch1.start).toHaveBeenCalledTimes(1)
    expect(ch2.start).toHaveBeenCalledTimes(1)

    // channels map 應包含兩個 channel
    expect(ctx.channels.size).toBe(2)
    expect(ctx.channels.get('discord')).toBe(ch1)
    expect(ctx.channels.get('line')).toBe(ch2)

    // scheduler.start() 應被呼叫
    expect(startMock).toHaveBeenCalledTimes(1)

    await ctx.shutdown([ch1, ch2])
  })

  test('shutdown() 順序正確：channels → scheduler → agents', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const callOrder: string[] = []
    const { factory } = makeFakeSchedulerFactory(callOrder)
    const config = makeTestConfig()

    const ctx = await bootstrap(config, {
      dbPath,
      createScheduler: factory,
    })

    // 建立 channel 帶有 call order 追蹤
    const ch = makeFakeChannel('discord')
    const originalStop = ch.stop
    ch.stop = mock(() => {
      callOrder.push('channel.stop')
      return (originalStop as () => Promise<void>)()
    })

    await ctx.startChannels([ch])

    // 透過發送訊息觸發 agent 建立
    channel_onMessage(ch, makeMessage({ groupId: 'group-order' }))
    expect(ctx.groupAgents.has('group-order')).toBe(true)

    // 替換 agent.shutdown 追蹤呼叫順序
    const agent = ctx.groupAgents.get('group-order')!
    const originalAgentShutdown = agent.shutdown.bind(agent)
    agent.shutdown = async () => {
      callOrder.push('agent.shutdown')
      await originalAgentShutdown()
    }

    await ctx.shutdown([ch])

    // 驗證關閉順序
    expect(callOrder).toEqual([
      'scheduler.start', // 來自 startChannels
      'channel.stop',
      'scheduler.stop',
      'agent.shutdown',
    ])
  })

  test('重啟後 scheduler factory 被再次呼叫（新的 scheduler 實例）', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const callOrder: string[] = []
    const { factory } = makeFakeSchedulerFactory(callOrder)
    const config = makeTestConfig()

    // 第一次啟動
    const ctx1 = await bootstrap(config, {
      dbPath,
      createScheduler: factory,
    })
    await ctx1.shutdown([])

    const callOrder2: string[] = []
    const { factory: factory2 } = makeFakeSchedulerFactory(callOrder2)

    const ctx2 = await bootstrap(config, {
      dbPath,
      createScheduler: factory2,
    })

    // 第二次的 scheduler factory 也應被呼叫
    expect(factory2).toHaveBeenCalledTimes(1)

    await ctx2.shutdown([])
  })

  test('handleMessage() 多次訊息累積 pending_chars', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const callOrder: string[] = []
    const { factory } = makeFakeSchedulerFactory(callOrder)
    const config = makeTestConfig()

    const ctx = await bootstrap(config, {
      dbPath,
      createScheduler: factory,
    })

    const channel = makeFakeChannel('discord')
    await ctx.startChannels([channel])

    // 發送兩則訊息到同一群組
    channel_onMessage(channel, makeMessage({ groupId: 'group-accumulate', content: 'AAAA' })) // 4 chars
    channel_onMessage(channel, makeMessage({ groupId: 'group-accumulate', content: 'BBBBB' })) // 5 chars

    // 驗證累積的 pending_chars
    const sqlite = new Database(dbPath, { readonly: true })
    const row = sqlite.query('SELECT pending_chars FROM pending_triggers WHERE group_id = ?').get('group-accumulate') as { pending_chars: number } | null
    sqlite.close()

    expect(row).not.toBeNull()
    expect(row!.pending_chars).toBe(9) // 4 + 5

    await ctx.shutdown([channel])
  })
})

/** 觸發 channel 的 onMessage callback（模擬平台訊息進入） */
function channel_onMessage(ch: PlatformChannel, msg: UnifiedMessage): void {
  ch.onMessage(msg)
}
