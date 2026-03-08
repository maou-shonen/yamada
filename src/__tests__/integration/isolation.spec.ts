/**
 * T3-ISOLATE: 多群組隔離 + 跨平台整合測試
 *
 * 驗證：
 * - 每個群組有獨立的 Agent + per-group DB
 * - 群組 A 的訊息不會出現在群組 B 的 DB
 * - Discord 和 LINE 訊息路由到不同群組時各自投遞
 * - 同一群組的 trigger 獨立，不互相影響
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

// 設定必要環境變數
Object.assign(process.env, {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
})

// ── Helpers ──

/** 產生唯一 temp 目錄路徑 */
function makeTempDir(): string {
  const dir = path.join('/tmp', `yamada-isolation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    analyzeImage: (mock(async () => 'mock image analysis') as unknown) as AgentServices['analyzeImage'],
    getImageById: (mock(() => null) as unknown) as AgentServices['getImageById'],
    // No-op 背景任務
    runObserver: (mock(async () => {}) as unknown) as AgentServices['runObserver'],
    processNewChunks: (mock(async () => {}) as unknown) as AgentServices['processNewChunks'],
    ...overrides,
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── T3-ISOLATE 多群組隔離 + 跨平台整合 ──

describe('T3-ISOLATE: 多群組隔離 + 跨平台整合測試', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  test('IS-1: 兩個群組各有獨立 Agent — group-A 的訊息不出現在 group-B 的 DB', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    const config = makeTestConfig()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })
    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 發送訊息到 group-A
    fakeChannel.onMessage(makeMessage({
      groupId: 'group-a',
      userId: 'user-a1',
      userName: 'Alice',
      content: 'group-A 訊息 1',
    }))

    // 發送訊息到 group-B
    fakeChannel.onMessage(makeMessage({
      groupId: 'group-b',
      userId: 'user-b1',
      userName: 'Bob',
      content: 'group-B 訊息 1',
    }))

    // 等待處理完成
    await sleep(300)

    // 驗證：ctx.groupAgents 有 2 個 agent
    expect(ctx.groupAgents.size).toBe(2)
    expect(ctx.groupAgents.has('group-a')).toBe(true)
    expect(ctx.groupAgents.has('group-b')).toBe(true)

    // 驗證：group-A 只看得到 group-A 的訊息
    const messagesA = getRecentMessages(ctx.appDb.db, 'group-a', 50)
    expect(messagesA.length).toBeGreaterThanOrEqual(1)
    expect(messagesA.some(m => m.content === 'group-A 訊息 1')).toBe(true)
    expect(messagesA.some(m => m.content === 'group-A 訊息 1')).toBe(true)
    expect(messagesA.some(m => m.content === 'group-B 訊息 1')).toBe(false)

    // 驗證：group-B 只看得到 group-B 的訊息
    const messagesB = getRecentMessages(ctx.appDb.db, 'group-b', 50)
    expect(messagesB.length).toBeGreaterThanOrEqual(1)
    expect(messagesB.some(m => m.content === 'group-B 訊息 1')).toBe(true)
    expect(messagesB.some(m => m.content === 'group-B 訊息 1')).toBe(true)
    expect(messagesB.some(m => m.content === 'group-A 訊息 1')).toBe(false)

    // 驗證：bot 回覆也在各自的 DB 中
    const botMsgsA = messagesA.filter(m => m.isBot)
    const botMsgsB = messagesB.filter(m => m.isBot)
    expect(botMsgsA.length).toBeGreaterThanOrEqual(1)
    expect(botMsgsB.length).toBeGreaterThanOrEqual(1)

    await ctx.shutdown([fakeChannel])
  })

  test('IS-2: Discord 和 LINE 訊息路由到不同群組 → 各自投遞到對應 channel', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    const services = createChainServices()
    const config = makeTestConfig()

    const ctx = await bootstrap(config, { dbPath, agentServices: services })

    // 建立兩個 fake channel（模擬 Discord 和 LINE）
    const discordChannel = makeFakeChannel('discord')
    const lineChannel = makeFakeChannel('line')

    await ctx.startChannels([discordChannel, lineChannel])

    // 發送 Discord 訊息到 group-d
    discordChannel.onMessage(makeMessage({
      groupId: 'group-d',
      platform: 'discord',
      userId: 'discord-user-1',
      userName: 'DiscordUser',
      content: 'Discord 訊息',
    }))

    // 發送 LINE 訊息到 group-l
    lineChannel.onMessage(makeMessage({
      groupId: 'group-l',
      platform: 'line',
      userId: 'line-user-1',
      userName: 'LineUser',
      content: 'LINE 訊息',
    }))

    // 等待處理完成
    await sleep(300)

    // 驗證：Discord channel 的 sendMessage 被呼叫（用於 group-d 回覆）
    const discordSendMock = discordChannel.sendMessage as ReturnType<typeof mock>
    expect(discordSendMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    // 驗證：LINE channel 的 sendMessage 被呼叫（用於 group-l 回覆）
    const lineSendMock = lineChannel.sendMessage as ReturnType<typeof mock>
    expect(lineSendMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    // 驗證：各群組 DB 中的訊息來自正確的平台
    const messagesD = getRecentMessages(ctx.appDb.db, 'group-d', 50)
    expect(messagesD.some(m => m.content === 'Discord 訊息')).toBe(true)

    const messagesL = getRecentMessages(ctx.appDb.db, 'group-l', 50)
    expect(messagesL.some(m => m.content === 'LINE 訊息')).toBe(true)

    await ctx.shutdown([discordChannel, lineChannel])
  })

  test('IS-3: 同一群組 trigger 獨立 — group-A 觸發不影響 group-B 的 pending trigger', async () => {
    const tmpDir = makeTempDir()
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'yamada.db')

    // 使用 fake scheduler 避免自動觸發，只驗證 trigger 狀態
    const fakeSchedulerFactory = mock((): { start: () => void, stop: () => Promise<void> } => ({
      start: () => {},
      stop: async () => {},
    }))

    const services = createChainServices()
    const config = makeTestConfig()

    const ctx = await bootstrap(config, {
      dbPath,
      createScheduler: fakeSchedulerFactory,
      agentServices: services,
    })

    const fakeChannel = makeFakeChannel('discord')
    await ctx.startChannels([fakeChannel])

    // 發送訊息到 group-A（會觸發 overflow，trigger_at 應該很短）
    fakeChannel.onMessage(makeMessage({
      groupId: 'group-a-trigger',
      content: 'A'.repeat(120), // 超過 OVERFLOW_CHARS=100
    }))

    // 發送訊息到 group-B（正常訊息，trigger_at 應該較長）
    fakeChannel.onMessage(makeMessage({
      groupId: 'group-b-trigger',
      content: '正常訊息',
    }))

    // 等待訊息處理
    await sleep(100)

    // 驗證 DB 中的 trigger 狀態
    const sqlite = new Database(dbPath, { readonly: true })

    // group-A trigger：overflow 觸發，trigger_at 應該很短（接近現在）
    const triggerA = sqlite.query('SELECT * FROM pending_triggers WHERE group_id = ?').get('group-a-trigger') as Record<string, unknown> | null
    expect(triggerA).not.toBeNull()
    expect(triggerA!.group_id).toBe('group-a-trigger')
    expect(triggerA!.status).toBe('pending')
    // overflow 觸發時 trigger_at 應該接近現在（相對於 group-B）
    const triggerAtA = Number(triggerA!.trigger_at)

    // group-B trigger：正常訊息，trigger_at 應該較長（silence debounce）
    const triggerB = sqlite.query('SELECT * FROM pending_triggers WHERE group_id = ?').get('group-b-trigger') as Record<string, unknown> | null
    expect(triggerB).not.toBeNull()
    expect(triggerB!.group_id).toBe('group-b-trigger')
    expect(triggerB!.status).toBe('pending')
    const triggerAtB = Number(triggerB!.trigger_at)

    // 驗證：group-A 的 trigger_at 應該小於 group-B（overflow 更急迫）
    expect(triggerAtA).toBeLessThan(triggerAtB)

    sqlite.close()

    await ctx.shutdown([fakeChannel])
  })
})
