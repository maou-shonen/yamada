/**
 * T1-CHAIN + T2-TRIGGER: 完整鏈路整合測試
 *
 * 驗證：channel.onMessage → handleMessage → trigger upsert → scheduler claim
 *       → agent.processTriggeredMessages → deliverReply → channel.sendMessage
 *
 * 使用真實 scheduler + 真實 storage + mock AI/context，
 * 確保 debounce → trigger → AI → delivery 的完整端對端流程。
 */

import type { AgentServices } from '../../agent/index'
import type { PlatformChannel, UnifiedMessage } from '../../types'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { bootstrap } from '../../bootstrap'
import { deliverReaction, deliverReply } from '../../lib/delivery'
import { getRecentMessages, saveBotMessage, saveMessage } from '../../storage/messages'
import { recordActivity } from '../../storage/user-stats'
import { getOrCreateAlias, getAliasMap } from '../../storage/user-aliases'
import { createTestConfig } from '../helpers/config'

Object.assign(process.env, {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
})

// ── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join('/tmp', `yamada-chain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    groupId: overrides.groupId ?? 'chain-group',
    userId: overrides.userId ?? 'user-1',
    userName: overrides.userName ?? 'Alice',
    content: overrides.content ?? '你好呀',
    timestamp: overrides.timestamp ?? new Date(),
    platform: overrides.platform ?? 'discord',
    isBot: overrides.isBot ?? false,
    isMention: overrides.isMention ?? false,
  }
}

function makeTestCfg(overrides: Parameters<typeof createTestConfig>[0] = {}) {
  return createTestConfig({
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: 'test-client-id',
    discordEnabled: true,
    DISCORD_GROUP_ID_MODE: 'guild',
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    lineEnabled: true,
    LINE_WEBHOOK_PORT: 3000,
    embeddingEnabled: false,
    // 短 debounce + 快 polling，讓測試能快速走完全鏈路
    DEBOUNCE_SILENCE_MS: 30,
    DEBOUNCE_URGENT_MS: 10,
    DEBOUNCE_OVERFLOW_CHARS: 100,
    SCHEDULER_POLL_INTERVAL_MS: 10,
    ...overrides,
  })
}

/** 混合真實 storage/delivery + mock AI/context 的服務集 */
function createChainServices(overrides: Partial<AgentServices> = {}): AgentServices {
  return {
    // 真實 storage（使用 bootstrap 建立的 per-group DB）
    saveMessage,
    saveBotMessage,
    getRecentMessages,
    recordActivity,
    getOrCreateAlias: getOrCreateAlias as AgentServices['getOrCreateAlias'],
    getAliasMap: getAliasMap as AgentServices['getAliasMap'],
    // 真實 delivery（會呼叫 channel.sendMessage / sendReaction）
    deliverReply,
    deliverReaction,
    // Mock AI/context（避免真實 LLM 呼叫）
    assembleContext: (mock(async () => [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'hello' },
    ]) as unknown) as AgentServices['assembleContext'],
    generateReply: (mock(async () => ({
      actions: [{ type: 'reply' as const, content: 'AI 回覆' }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })) as unknown) as AgentServices['generateReply'],
    checkFrequency: (mock(() => ({
      shouldRespond: true,
      probability: 1,
      metadata: {
        emaLongShare: 0,
        emaShortShare: 0,
        target: 0.2,
        activeMembers: 1,
        rng: 0,
        isMention: false,
        reason: 'pass',
      },
    })) as unknown) as AgentServices['checkFrequency'],
    // No-op 背景任務
    runObserver: (mock(async () => {}) as unknown) as AgentServices['runObserver'],
    processNewChunks: (mock(async () => {}) as unknown) as AgentServices['processNewChunks'],
    ...overrides,
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── T1-CHAIN 完整鏈路 ──────────────────────────────────────────

describe('T1-CHAIN: 完整鏈路整合測試', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  test('CH-1: 訊息 → silence trigger → scheduler claim → AI reply → channel.sendMessage', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    const config = makeTestCfg()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 模擬平台訊息進入
    fakeChannel.onMessage(makeMessage({ groupId: 'chain-group', content: '你好' }))

    // 等待 debounce(30ms) + scheduler poll(10ms) + processing
    await sleep(300)

    // 驗證：完整鏈路已執行
    const generateMock = services.generateReply as ReturnType<typeof mock>
    expect(generateMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    const sendMock = fakeChannel.sendMessage as ReturnType<typeof mock>
    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    // 驗證：sendMessage 收到的 content 包含 AI 回覆
    const sentContent = String(sendMock.mock.calls[0]?.[1] ?? '')
    expect(sentContent).toBe('AI 回覆')

    await ctx.shutdown([fakeChannel])
  })

  test('CH-2: @mention → urgent trigger → AI reply 正常投遞', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    const config = makeTestCfg()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // @mention 訊息
    fakeChannel.onMessage(makeMessage({ groupId: 'mention-group', content: '嗨', isMention: true }))

    // urgent 模式 debounce 更短(10ms)
    await sleep(200)

    const generateMock = services.generateReply as ReturnType<typeof mock>
    expect(generateMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    const sendMock = fakeChannel.sendMessage as ReturnType<typeof mock>
    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    await ctx.shutdown([fakeChannel])
  })

  test('CH-3: 溢出觸發 → 累積字元超過 OVERFLOW_CHARS 時立即處理', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    // OVERFLOW_CHARS = 100，一次送超過 100 字元
    const config = makeTestCfg({ DEBOUNCE_OVERFLOW_CHARS: 100, DEBOUNCE_SILENCE_MS: 60_000 })

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 發送長訊息觸發 overflow
    fakeChannel.onMessage(makeMessage({ groupId: 'overflow-group', content: 'A'.repeat(120) }))

    // overflow 觸發後 scheduler 會在下一次 poll 時 claim
    await sleep(200)

    const generateMock = services.generateReply as ReturnType<typeof mock>
    expect(generateMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    await ctx.shutdown([fakeChannel])
  })

  test('CH-4: skip action → 不呼叫 sendMessage，不儲存 bot 訊息', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices({
      generateReply: (mock(async () => ({
        actions: [{ type: 'skip' as const, reason: '不需要回應' }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })) as unknown) as AgentServices['generateReply'],
    })
    const config = makeTestCfg()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    fakeChannel.onMessage(makeMessage({ groupId: 'skip-group', content: '嗨' }))
    await sleep(300)

    // skip action → 不投遞
    const sendMock = fakeChannel.sendMessage as ReturnType<typeof mock>
    expect(sendMock.mock.calls.length).toBe(0)

    // 驗證 DB 中沒有 bot 訊息
    const messages = getRecentMessages(ctx.appDb.db, 'skip-group', 20)
    const botMsgs = messages.filter(m => m.isBot)
    expect(botMsgs.length).toBe(0)

    await ctx.shutdown([fakeChannel])
  })

  test('CH-5: 全鏈路 DB 持久化 — 用戶訊息 + bot 回覆皆存在於 per-group DB', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    const config = makeTestCfg()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    fakeChannel.onMessage(makeMessage({ groupId: 'persist-group', content: '持久化測試' }))
    await sleep(300)

    // 驗證 per-group DB 包含用戶訊息和 bot 回覆
    const messages = getRecentMessages(ctx.appDb.db, 'persist-group', 20)

    const userMsgs = messages.filter(m => !m.isBot)
    expect(userMsgs.length).toBeGreaterThanOrEqual(1)
    expect(userMsgs.some(m => m.content === '持久化測試')).toBe(true)

    const botMsgs = messages.filter(m => m.isBot)
    expect(botMsgs.length).toBeGreaterThanOrEqual(1)
    expect(botMsgs.some(m => m.content === 'AI 回覆')).toBe(true)

    await ctx.shutdown([fakeChannel])
  })

  test('CH-6: trigger 完成後新訊息建立新 trigger → 可再次觸發 AI pipeline', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    const config = makeTestCfg()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 第一輪：發送訊息 → 等待處理完成
    fakeChannel.onMessage(makeMessage({ groupId: 'rearm-group', content: '第一輪' }))
    await sleep(300)

    const generateMock = services.generateReply as ReturnType<typeof mock>
    expect(generateMock.mock.calls.length).toBe(1)

    // 第二輪：發送新訊息 → 應建立新 trigger 再次觸發
    fakeChannel.onMessage(makeMessage({ groupId: 'rearm-group', content: '第二輪' }))
    await sleep(300)

    expect(generateMock.mock.calls.length).toBe(2)

    await ctx.shutdown([fakeChannel])
  })
})

// ── T2-TRIGGER 狀態機整合 ───────────────────────────────────────

describe('T2-TRIGGER: handleMessage → trigger 狀態整合測試', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  test('TR-1: isMention sticky — 先非 mention 再 mention → trigger 帶 is_mention=1', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    // 用 fake scheduler 避免自動觸發，只驗證 trigger 狀態
    const fakeSchedulerFactory = mock((): { start: () => void, stop: () => Promise<void> } => ({
      start: () => {},
      stop: async () => {},
    }))
    const services = createChainServices()
    const config = makeTestCfg({ DEBOUNCE_SILENCE_MS: 60_000 })

    const ctx = await bootstrap(config, {
      dbPath,
      agentServices: services,
      createScheduler: fakeSchedulerFactory as Parameters<typeof bootstrap>[1] extends infer O ? O extends { createScheduler?: infer F } ? F : never : never,
    })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 第一則：非 mention
    fakeChannel.onMessage(makeMessage({ groupId: 'sticky-group', content: 'hi', isMention: false }))
    // 第二則：mention
    fakeChannel.onMessage(makeMessage({ groupId: 'sticky-group', content: 'hey', isMention: true }))

    // 驗證 trigger 的 is_mention 為 sticky（MAX）
    const sqlite = new Database(dbPath, { readonly: true })
    const row = sqlite.query('SELECT is_mention, pending_chars FROM pending_triggers WHERE group_id = ?').get('sticky-group') as { is_mention: number, pending_chars: number } | null
    sqlite.close()

    expect(row).not.toBeNull()
    expect(row!.is_mention).toBe(1)
    expect(row!.pending_chars).toBe(5) // 'hi'(2) + 'hey'(3)

    await ctx.shutdown([fakeChannel])
  })

  test('TR-2: 非 mention 訊息不清除已有的 mention flag', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const fakeSchedulerFactory = mock(() => ({
      start: () => {},
      stop: async () => {},
    }))
    const services = createChainServices()
    const config = makeTestCfg({ DEBOUNCE_SILENCE_MS: 60_000 })

    const ctx = await bootstrap(config, {
      dbPath,
      agentServices: services,
      createScheduler: fakeSchedulerFactory as Parameters<typeof bootstrap>[1] extends infer O ? O extends { createScheduler?: infer F } ? F : never : never,
    })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // mention → 非 mention → 非 mention
    fakeChannel.onMessage(makeMessage({ groupId: 'persist-mention', content: 'a', isMention: true }))
    fakeChannel.onMessage(makeMessage({ groupId: 'persist-mention', content: 'b', isMention: false }))
    fakeChannel.onMessage(makeMessage({ groupId: 'persist-mention', content: 'c', isMention: false }))

    const sqlite = new Database(dbPath, { readonly: true })
    const row = sqlite.query('SELECT is_mention FROM pending_triggers WHERE group_id = ?').get('persist-mention') as { is_mention: number } | null
    sqlite.close()

    expect(row).not.toBeNull()
    // is_mention 應維持為 1（sticky）
    expect(row!.is_mention).toBe(1)

    await ctx.shutdown([fakeChannel])
  })

  test('TR-3: 多則訊息累積 pending_chars 正確', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const fakeSchedulerFactory = mock(() => ({
      start: () => {},
      stop: async () => {},
    }))
    const services = createChainServices()
    const config = makeTestCfg({ DEBOUNCE_SILENCE_MS: 60_000 })

    const ctx = await bootstrap(config, {
      dbPath,
      agentServices: services,
      createScheduler: fakeSchedulerFactory as Parameters<typeof bootstrap>[1] extends infer O ? O extends { createScheduler?: infer F } ? F : never : never,
    })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 發送 3 則不同長度的訊息
    fakeChannel.onMessage(makeMessage({ groupId: 'accum-group', content: 'AAAA' }))       // 4 chars
    fakeChannel.onMessage(makeMessage({ groupId: 'accum-group', content: 'BBBBB' }))      // 5 chars
    fakeChannel.onMessage(makeMessage({ groupId: 'accum-group', content: 'CCCCCCCC' }))   // 8 chars

    const sqlite = new Database(dbPath, { readonly: true })
    const row = sqlite.query('SELECT pending_chars FROM pending_triggers WHERE group_id = ?').get('accum-group') as { pending_chars: number } | null
    sqlite.close()

    expect(row).not.toBeNull()
    expect(row!.pending_chars).toBe(17) // 4 + 5 + 8

    await ctx.shutdown([fakeChannel])
  })
})
