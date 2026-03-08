import type { AgentServices } from '../../agent/index'
import type { VectorStore } from '../../storage/vector-store'
import type { PlatformChannel } from '../../types'
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
import { getFrequencyState } from '../../storage/frequency-stats'
import { getRecentMessages, saveBotMessage, saveMessage } from '../../storage/messages'
import { createTestConfig } from '../helpers/config.ts'
import { setupTestDb } from '../helpers/setup-db'

function makeMockChannel(name: string): PlatformChannel {
  return {
    name,
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    sendMessage: mock(() => Promise.resolve()),
    sendReaction: mock(() => Promise.resolve()),
    onMessage: mock(() => {}),
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
    embeddingEnabled: true,
    ...overrides,
  })
}

function createTestServices(overrides: Partial<AgentServices> = {}) {
  const generateReplyMock = mock(async () => ({
    actions: [{ type: 'reply' as const, content: 'AI 頻率測試回覆' }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }))

  const checkFrequencyMock = mock((...args: unknown[]) => {
    const isMention = args[2] === true
    return {
      shouldRespond: true,
      probability: 1,
      metadata: {
        emaLongShare: 0,
        emaShortShare: 0,
        target: 0.2,
        activeMembers: 3,
        rng: 0,
        isMention,
        reason: isMention ? 'mention_bypass' : 'pass',
      },
    }
  })

  const services: AgentServices = {
    saveMessage,
    saveBotMessage,
    getRecentMessages,
    assembleContext: (mock(async () => [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'user-1: hello' },
    ]) as unknown) as AgentServices['assembleContext'],
    generateReply: generateReplyMock as unknown as AgentServices['generateReply'],
    deliverReply: (mock(async () => {}) as unknown) as AgentServices['deliverReply'],
    deliverReaction: (mock(async () => {}) as unknown) as AgentServices['deliverReaction'],
    runObserver: (mock(async () => {}) as unknown) as AgentServices['runObserver'],
    processNewChunks: (mock(async () => {}) as unknown) as AgentServices['processNewChunks'],
    recordActivity: (mock(() => {}) as unknown) as AgentServices['recordActivity'],
    checkFrequency: checkFrequencyMock as unknown as AgentServices['checkFrequency'],
    analyzeImage: (mock(async () => 'mock image analysis') as unknown) as AgentServices['analyzeImage'],
    getImageById: (mock((_db, _groupId, _id) => null) as unknown) as AgentServices['getImageById'],
    getOrCreateAlias: (mock(async () => ({ alias: 'test_alias', userName: 'TestUser' })) as unknown) as AgentServices['getOrCreateAlias'],
    getAliasMap: (mock(async () => new Map()) as unknown) as AgentServices['getAliasMap'],
    ...overrides,
  }

  return {
    services,
    mocks: {
      generateReplyMock,
      checkFrequencyMock,
    },
  }
}

describe('Frequency pipeline 整合測試', () => {
  test('頻率控制 skip 時 LLM 不被呼叫', async () => {
    const config = makeTestConfig()
    const { db } = setupTestDb()

    const { services, mocks } = createTestServices({
      checkFrequency: (mock(() => ({
        shouldRespond: false,
        probability: 0.1,
        metadata: {
          emaLongShare: 0.8,
          emaShortShare: 0.8,
          target: 0.2,
          activeMembers: 4,
          rng: 0.9,
          isMention: false,
          reason: 'probability_gate',
        },
      })) as unknown) as AgentServices['checkFrequency'],
    })

    const agent = new Agent({
      groupId: 'group-a',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', makeMockChannel('discord')]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.generateReplyMock.mock.calls.length).toBe(0)
  })

  test('頻率控制 pass 時 LLM 會被呼叫', async () => {
    const config = makeTestConfig()
    const { db } = setupTestDb()

    const { services, mocks } = createTestServices({
      checkFrequency: (mock(() => ({
        shouldRespond: true,
        probability: 0.9,
        metadata: {
          emaLongShare: 0.1,
          emaShortShare: 0.1,
          target: 0.2,
          activeMembers: 4,
          rng: 0.2,
          isMention: false,
          reason: 'pass',
        },
      })) as unknown) as AgentServices['checkFrequency'],
    })

    const agent = new Agent({
      groupId: 'group-a',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', makeMockChannel('discord')]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    expect(mocks.generateReplyMock.mock.calls.length).toBe(1)
  })

  test('reply 後會更新 frequency_state EMA', async () => {
    const config = makeTestConfig()
    const { db } = setupTestDb()
    const { services } = createTestServices()

    const agent = new Agent({
      groupId: 'group-a',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', makeMockChannel('discord')]]),
      services,
    })

    await agent.processTriggeredMessages('discord', false)

    const state = getFrequencyState(db, 'group-a')
    expect(state).toBeDefined()
    expect(state?.emaLongBot).toBeGreaterThan(0)
  })

  test('mention bypass 時即使平常會拒絕仍會通過', async () => {
    const config = makeTestConfig()
    const { db } = setupTestDb()

    const { services, mocks } = createTestServices({
      checkFrequency: (mock((...args: unknown[]) => {
        const isMention = args[3] === true
        return {
          shouldRespond: isMention,
          probability: isMention ? 1 : 0.05,
          metadata: {
            emaLongShare: 0.8,
            emaShortShare: 0.8,
            target: 0.2,
            activeMembers: 4,
            rng: 0.9,
            isMention,
            reason: isMention ? 'mention_bypass' : 'probability_gate',
          },
        }
      }) as unknown) as AgentServices['checkFrequency'],
    })

    const agent = new Agent({
      groupId: 'group-a',
      config,
      db,
      vectorStore: createFakeVectorStore(),
      channels: new Map([['discord', makeMockChannel('discord')]]),
      services,
    })

    await agent.processTriggeredMessages('discord', true)

    expect(mocks.generateReplyMock.mock.calls.length).toBe(1)
  })
})
