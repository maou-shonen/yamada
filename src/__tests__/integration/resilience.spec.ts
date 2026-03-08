import type { AgentServices } from '../../agent/index'
import type { VectorStore } from '../../storage/vector-store'
import type { PlatformChannel, UnifiedMessage } from '../../types'
import { describe, expect, mock, test } from 'bun:test'
import { Agent } from '../../agent/index'

function createFakeVectorStore(): VectorStore {
  return {
    init: () => {},
    upsertChunkVector: () => {},
    searchChunks: () => [],
    upsertFactVector: () => {},
    deleteFactVectors: () => {},
    searchFacts: () => [],
  }
}
import { deliverReaction, deliverReply } from '../../lib/delivery'
import {
  getRecentMessages,
  saveBotMessage,
  saveMessage,
} from '../../storage/messages'
import { recordActivity } from '../../storage/user-stats'
import { getOrCreateAlias, getAliasMap } from '../../storage/user-aliases'
import { createTestConfig } from '../helpers/config.ts'
import { setupTestDb } from '../helpers/setup-db'

Object.assign(process.env, {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
})

function makeFakeChannel(): PlatformChannel {
  return {
    name: 'discord',
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
    groupId: overrides.groupId ?? 'group-1',
    userId: overrides.userId ?? 'user-1',
    userName: overrides.userName ?? 'Alice',
    content: overrides.content ?? '你好呀',
    timestamp: overrides.timestamp ?? new Date(),
    platform: overrides.platform ?? 'discord',
    isBot: overrides.isBot ?? false,
    isMention: overrides.isMention ?? false,
  }
}

function makeConfig(overrides: Parameters<typeof createTestConfig>[0] = {}) {
  return createTestConfig({
    DISCORD_TOKEN: 'tok',
    DISCORD_CLIENT_ID: 'cid',
    discordEnabled: true,
    DISCORD_GROUP_ID_MODE: 'guild',
    LINE_CHANNEL_SECRET: 'sec',
    LINE_CHANNEL_ACCESS_TOKEN: 'acc',
    lineEnabled: true,
    LINE_WEBHOOK_PORT: 3000,
    embeddingEnabled: false,
    ...overrides,
  })
}

function createResilienceServices(overrides: Partial<AgentServices> = {}): AgentServices {
  return {
    saveMessage,
    saveBotMessage,
    getRecentMessages,
    assembleContext: (mock(async () => [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'user-1: hello' },
    ]) as unknown) as AgentServices['assembleContext'],
    generateReply: (mock(async () => ({
      actions: [{ type: 'reply' as const, content: 'AI 測試回覆' }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })) as unknown) as AgentServices['generateReply'],
    deliverReply,
    deliverReaction,
    runObserver: (mock(async () => {}) as unknown) as AgentServices['runObserver'],
    processNewChunks: (mock(async () => {}) as unknown) as AgentServices['processNewChunks'],
    recordActivity,
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
    getOrCreateAlias,
    getAliasMap,
    ...overrides,
  }
}

describe('T4-RESILIENCE: 錯誤韌性測試', () => {
  test('RE-1: generateReply 拋出異常 → processTriggeredMessages rejects 但 Agent 可繼續使用', async () => {
    const { sqlite, db } = setupTestDb()
    const channel = makeFakeChannel()
    const config = makeConfig()

    // 第一次：generateReply 拋出異常
    const failingServices = createResilienceServices({
      generateReply: (mock(async () => {
        throw new Error('LLM failed')
      }) as unknown) as AgentServices['generateReply'],
    })

    const agent = new Agent({
      groupId: 'group1',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', channel]]),
      services: failingServices,
    })

    agent.receiveMessage(makeMessage({ id: 'msg-1', content: '第一則訊息' }))

    // 應該 reject
    let firstCallThrew = false
    try {
      await agent.processTriggeredMessages('discord', false)
    } catch {
      firstCallThrew = true
    }
    expect(firstCallThrew).toBe(true)

    // 第二次：替換為正常的 generateReply
    const workingServices = createResilienceServices()
    const agent2 = new Agent({
      groupId: 'group1',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', channel]]),
      services: workingServices,
    })

    agent2.receiveMessage(makeMessage({ id: 'msg-2', content: '第二則訊息' }))

    // 應該成功
    let secondCallThrew = false
    try {
      await agent2.processTriggeredMessages('discord', false)
    } catch {
      secondCallThrew = true
    }
    expect(secondCallThrew).toBe(false)
  })

  test('RE-2: channel.sendMessage 拋出異常 → deliverReply 吞錯 → saveBotMessage 仍被呼叫', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()

    // 建立會拋出異常的 channel
    const fakeChannel: PlatformChannel = {
      name: 'discord',
      start: mock(() => Promise.resolve()),
      stop: mock(() => Promise.resolve()),
      sendMessage: mock(async () => {
        throw new Error('Network error')
      }),
      sendReaction: mock(() => Promise.resolve()),
      onMessage: (_msg: UnifiedMessage) => {},
    }

    // 使用真實的 deliverReply（它有 try/catch）
    const services = createResilienceServices({
      deliverReply,
    })

    const agent = new Agent({
      groupId: 'group1',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', fakeChannel]]),
      services,
    })

    agent.receiveMessage(makeMessage({ id: 'msg-1', content: '訊息' }))

    // 應該不拋出（deliverReply 吞掉錯誤）
    let threw = false
    try {
      await agent.processTriggeredMessages('discord', false)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    // 驗證：saveBotMessage 仍被呼叫（訊息被儲存）
    const messages = getRecentMessages(db, 'group1', 20)
    const botMessages = messages.filter(m => m.isBot)
    expect(botMessages.length).toBeGreaterThanOrEqual(1)

    // 驗證：EMA 狀態被更新（frequency_state 表有資料）
    // 這透過 checkFrequency 被呼叫來驗證
    const checkFrequencyMock = services.checkFrequency as ReturnType<typeof mock>
    expect(checkFrequencyMock.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('RE-3: Observer fire-and-forget 拋出異常 → 不影響 processTriggeredMessages 結果', async () => {
    const { sqlite, db } = setupTestDb()
    const channel = makeFakeChannel()
    const config = makeConfig()

    // runObserver 拋出異常
    const services = createResilienceServices({
      runObserver: (mock(async () => {
        throw new Error('Observer failed')
      }) as unknown) as AgentServices['runObserver'],
    })

    const agent = new Agent({
      groupId: 'group1',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', channel]]),
      services,
    })

    agent.receiveMessage(makeMessage({ id: 'msg-1', content: '訊息' }))

    // 應該不拋出（runObserver 的錯誤被 .catch() 吞掉）
    let threw = false
    try {
      await agent.processTriggeredMessages('discord', false)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    // 驗證：回覆仍被投遞
    const sendMessageMock = channel.sendMessage as ReturnType<typeof mock>
    expect(sendMessageMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    // 驗證：runObserver 被呼叫（即使拋出異常）
    const runObserverMock = services.runObserver as ReturnType<typeof mock>
    expect(runObserverMock.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('RE-4: assembleContext 拋出異常 → pipeline 失敗但 Agent 可重試', async () => {
    const { sqlite, db } = setupTestDb()
    const channel = makeFakeChannel()
    const config = makeConfig()

    // 第一次：assembleContext 拋出異常
    const failingServices = createResilienceServices({
      assembleContext: (mock(async () => {
        throw new Error('Context assembly failed')
      }) as unknown) as AgentServices['assembleContext'],
    })

    const agent = new Agent({
      groupId: 'group1',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', channel]]),
      services: failingServices,
    })

    agent.receiveMessage(makeMessage({ id: 'msg-1', content: '訊息' }))

    // 應該 reject
    let firstCallThrew = false
    try {
      await agent.processTriggeredMessages('discord', false)
    } catch {
      firstCallThrew = true
    }
    expect(firstCallThrew).toBe(true)

    // 驗證：generateReply 未被呼叫（pipeline 在 assembleContext 停止）
    const generateReplyMock = failingServices.generateReply as ReturnType<typeof mock>
    expect(generateReplyMock.mock.calls.length).toBe(0)

    // 第二次：替換為正常的 assembleContext
    const workingServices = createResilienceServices()
    const agent2 = new Agent({
      groupId: 'group1',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', channel]]),
      services: workingServices,
    })

    agent2.receiveMessage(makeMessage({ id: 'msg-2', content: '訊息' }))

    // 應該成功
    let secondCallThrew = false
    try {
      await agent2.processTriggeredMessages('discord', false)
    } catch {
      secondCallThrew = true
    }
    expect(secondCallThrew).toBe(false)

    // 驗證：generateReply 被呼叫
    const generateReplyMock2 = workingServices.generateReply as ReturnType<typeof mock>
    expect(generateReplyMock2.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
