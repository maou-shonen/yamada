import type { Config } from '../config/index.ts'
import type { AgentAction } from '../lib/generator'
import type { PlatformChannel, StoredMessage, UnifiedMessage } from '../types'
import type { AgentServices } from './index'
import { describe, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { Agent } from './index'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return createTestConfig({
    DISCORD_TOKEN: 'tok',
    DISCORD_CLIENT_ID: 'cid',
    discordEnabled: true,
    DISCORD_GROUP_ID_MODE: 'guild',
    LINE_CHANNEL_SECRET: 'sec',
    LINE_CHANNEL_ACCESS_TOKEN: 'acc',
    lineEnabled: true,
    LINE_WEBHOOK_PORT: 3000,
    embeddingEnabled: true,
    SOUL: 'You are helpful.',
    ...overrides,
  })
}

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    groupId: 'group1',
    userId: 'u1',
    userName: 'Alice',
    content: 'Hello',
    timestamp: new Date(),
    platform: 'discord',
    isBot: false,
    isMention: false,
    ...overrides,
  }
}

function makeChannel(): PlatformChannel {
  return {
    name: 'discord',
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    sendMessage: mock(() => Promise.resolve()),
    sendReaction: mock(() => Promise.resolve()),
    onMessage: mock(() => {}),
  }
}

function createFakeServices() {
  const saveMessageMock = mock(() => {})
  const saveBotMessageMock = mock(() => {})
  const getRecentMessagesMock = mock((): StoredMessage[] => [])
  const assembleContextMock = mock(async () => [{ role: 'system', content: 'test' }])
  const generateReplyMock = mock(async (): Promise<{ actions: AgentAction[], usage: { promptTokens: number, completionTokens: number, totalTokens: number } }> => ({
    actions: [{ type: 'reply' as const, content: 'AI reply' }],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  }))
  const deliverReplyMock = mock(async () => {})
  const deliverReactionMock = mock(async () => {})
  const runObserverMock = mock(async () => {})
  const processNewChunksMock = mock(async () => {})
  const recordActivityMock = mock(() => {})

  const services: AgentServices = {
    saveMessage: saveMessageMock as unknown as AgentServices['saveMessage'],
    saveBotMessage: saveBotMessageMock as unknown as AgentServices['saveBotMessage'],
    getRecentMessages: getRecentMessagesMock as unknown as AgentServices['getRecentMessages'],
    assembleContext: assembleContextMock as unknown as AgentServices['assembleContext'],
    generateReply: generateReplyMock as unknown as AgentServices['generateReply'],
    deliverReply: deliverReplyMock as unknown as AgentServices['deliverReply'],
    deliverReaction: deliverReactionMock as unknown as AgentServices['deliverReaction'],
    runObserver: runObserverMock as unknown as AgentServices['runObserver'],
    processNewChunks: processNewChunksMock as unknown as AgentServices['processNewChunks'],
    recordActivity: recordActivityMock as unknown as AgentServices['recordActivity'],
  }

  return {
    services,
    mocks: {
      saveMessageMock,
      saveBotMessageMock,
      getRecentMessagesMock,
      assembleContextMock,
      generateReplyMock,
      deliverReplyMock,
      deliverReactionMock,
      runObserverMock,
      processNewChunksMock,
      recordActivityMock,
    },
  }
}

describe('Agent', () => {
  test('receiveMessage → 只呼叫 saveMessage，不觸發 AI pipeline', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    const msg = makeMessage()
    agent.receiveMessage(msg)

    expect(mocks.saveMessageMock.mock.calls.length).toBe(1)
    expect(mocks.saveMessageMock).toHaveBeenCalledWith(expect.anything(), msg)
    // 確認不會觸發 pipeline
    expect(mocks.assembleContextMock.mock.calls.length).toBe(0)
    expect(mocks.generateReplyMock.mock.calls.length).toBe(0)
  })

  test('receiveMessage → 觸發 stats 記錄', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    const msg = makeMessage()
    agent.receiveMessage(msg)

    expect(mocks.recordActivityMock.mock.calls.length).toBe(1)
    expect(mocks.recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'u1',
        isSticker: false,
        hasUrl: false,
        isMention: false,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
  })

  test('receiveMessage → 貼圖訊息分類正確', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    const msg = makeMessage({ content: '[貼圖]' })
    agent.receiveMessage(msg)

    expect(mocks.recordActivityMock.mock.calls.length).toBe(1)
    expect(mocks.recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isSticker: true }),
    )
  })

  test('receiveMessage → 含 URL 訊息分類正確', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    const msg = makeMessage({ content: '看這個 https://example.com' })
    agent.receiveMessage(msg)

    expect(mocks.recordActivityMock.mock.calls.length).toBe(1)
    expect(mocks.recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hasUrl: true }),
    )
  })

  test('receiveMessage → @mention 訊息分類正確', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    const msg = makeMessage({ isMention: true })
    agent.receiveMessage(msg)

    expect(mocks.recordActivityMock.mock.calls.length).toBe(1)
    expect(mocks.recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isMention: true }),
    )
  })

  test('receiveMessage → stats 失敗不阻塞訊息管線', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    mocks.recordActivityMock.mockImplementation(() => {
      throw new Error('Stats error')
    })
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    const msg = makeMessage()
    // 不應該拋出異常
    expect(() => agent.receiveMessage(msg)).not.toThrow()
    // saveMessage 應該仍然被呼叫
    expect(mocks.saveMessageMock.mock.calls.length).toBe(1)
  })

  test('processTriggeredMessages → 完整 pipeline: assembleContext + generateReply + deliverReply + saveBotMessage', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const channel = makeChannel()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map([['discord', channel]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.assembleContextMock.mock.calls.length).toBe(1)
    expect(mocks.generateReplyMock.mock.calls.length).toBe(1)
    expect(mocks.deliverReplyMock.mock.calls.length).toBe(1)
    expect(mocks.saveBotMessageMock.mock.calls.length).toBe(1)
  })

  test('processTriggeredMessages → deliverReply 收到正確的 content 和 platform', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const channel = makeChannel()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map([['discord', channel]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.deliverReplyMock.mock.calls.length).toBe(1)
    expect(mocks.deliverReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'AI reply', platform: 'discord' }),
    )
  })

  test('skip action → 不呼叫 deliverReply 也不呼叫 saveBotMessage', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    mocks.generateReplyMock.mockImplementation(async () => ({
      actions: [{ type: 'skip' as const, reason: '不需要回應' }],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }))
    const channel = makeChannel()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map([['discord', channel]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.generateReplyMock.mock.calls.length).toBe(1)
    expect(mocks.deliverReplyMock.mock.calls.length).toBe(0)
    expect(mocks.saveBotMessageMock.mock.calls.length).toBe(0)
  })

  test('reaction action → deliverReaction 收到正確的 emoji', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    // 讓 getRecentMessages 回傳有 externalId 的訊息
    mocks.getRecentMessagesMock.mockImplementation(() => [
      { id: 1, externalId: 'msg-ext-1', userId: 'u1', content: 'hi', isBot: false, timestamp: Date.now(), replyToExternalId: null },
    ])
    mocks.generateReplyMock.mockImplementation(async () => ({
      actions: [{ type: 'reaction' as const, emoji: '👍' }],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }))
    const channel = makeChannel()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map([['discord', channel]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.deliverReactionMock.mock.calls.length).toBe(1)
    expect(mocks.deliverReactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ emoji: '👍', messageId: 'msg-ext-1' }),
    )
    expect(mocks.deliverReplyMock.mock.calls.length).toBe(0)
  })

  test('混合 actions → reaction + reply 皆執行', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    mocks.getRecentMessagesMock.mockImplementation(() => [
      { id: 1, externalId: 'msg-ext-1', userId: 'u1', content: 'hi', isBot: false, timestamp: Date.now(), replyToExternalId: null },
    ])
    mocks.generateReplyMock.mockImplementation(async () => ({
      actions: [
        { type: 'reaction' as const, emoji: '😂' },
        { type: 'reply' as const, content: '哈哈太好笑了' },
      ],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }))
    const channel = makeChannel()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map([['discord', channel]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.deliverReactionMock.mock.calls.length).toBe(1)
    expect(mocks.deliverReplyMock.mock.calls.length).toBe(1)
    expect(mocks.saveBotMessageMock.mock.calls.length).toBe(1)
  })

  test('Observer 和 Embedding 是 fire-and-forget（不阻塞回覆）', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.runObserverMock.mock.calls.length).toBe(1)
    expect(mocks.processNewChunksMock.mock.calls.length).toBe(1)
  })

  test('embeddingEnabled = false → 不呼叫 processNewChunks', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig({ embeddingEnabled: false }),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.runObserverMock.mock.calls.length).toBe(1)
    expect(mocks.processNewChunksMock.mock.calls.length).toBe(0)
  })

  test('無對應 channel → reply 不 deliver 但仍 saveBotMessage', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map(), // 空 channels
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.deliverReplyMock.mock.calls.length).toBe(0)
    expect(mocks.saveBotMessageMock.mock.calls.length).toBe(1)
  })

  test('LINE 平台 → platform 參數正確傳遞', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    const lineChannel = makeChannel()
    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig(),
      db,
      sqliteDb: sqlite,
      channels: new Map([['line', lineChannel]]),
      services,
    })

    await agent.processTriggeredMessages('line', false)

    expect(mocks.deliverReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'line' }),
    )
  })

  test('shutdown 等待 in-flight pipeline 完成', async () => {
    const { sqlite, db } = setupTestDb()
    const { services, mocks } = createFakeServices()
    let resolveGenerate!: (val: { actions: AgentAction[], usage: { promptTokens: number, completionTokens: number, totalTokens: number } }) => void
    const generateCalled = new Promise<void>((r) => {
      mocks.generateReplyMock.mockImplementationOnce(
        () => {
          r()
          return new Promise((resolve) => {
            resolveGenerate = resolve
          })
        },
      )
    })

    const agent = new Agent({
      groupId: 'group1',
      config: makeConfig({ SHUTDOWN_TIMEOUT_MS: 5000 }),
      db,
      sqliteDb: sqlite,
      channels: new Map(),
      services,
    })

    // 啟動 pipeline（不 await）
    const pipelinePromise = agent.processTriggeredMessages('discord', false)

    // 等待 generateReply 被呼叫（確保 resolveGenerate 已被指派）
    await generateCalled

    // 開始 shutdown（應該等待 pipeline）
    const shutdownPromise = agent.shutdown()

    // 釋放 pipeline
    resolveGenerate({
      actions: [{ type: 'skip' as const, reason: 'test' }],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    })

    await pipelinePromise
    await shutdownPromise

    expect(mocks.generateReplyMock.mock.calls.length).toBe(1)
  })
})
