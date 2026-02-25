import type { Config } from '../config/index.ts'
import type { StoredMessage } from '../types'
import type { ContextDeps } from './context'
import { describe, expect, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { getGroupSummary, getUserSummariesForGroup } from '../storage/summaries'
import { assembleContext, buildChatMessages } from './context'

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
    SOUL: 'You are a helpful assistant.',
    ...overrides,
  })
}

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 1,
    externalId: null,
    userId: 'user1',
    content: 'Hello world',
    isBot: false,
    timestamp: Date.now(),
    ...overrides,
  }
}

function createFakeDeps(): ContextDeps {
  return {
    getUserSummariesForGroup,
    getGroupSummary,
    embedText: (async () => [0.1, 0.2, 0.3]) as unknown as ContextDeps['embedText'],
    searchSimilar: (() => []) as unknown as ContextDeps['searchSimilar'],
  }
}

describe('assembleContext', () => {
  test('空訊息 → 只有 system message，含 <soul> 包裹的 SOUL', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    const deps = createFakeDeps()
    const messages = await assembleContext({
      recentMessages: [],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('<soul>')
    expect(messages[0].content).toContain('You are a helpful assistant.')
    expect(messages[0].content).toContain('</soul>')
  })

  test('用戶訊息格式："{userId}: {content}"', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    const msg = makeMessage({ userId: 'u1', content: 'Hi!', isBot: false })
    const deps = createFakeDeps()

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    const userMsg = messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toBe('u1: Hi!')
  })

  test('Bot 訊息格式：assistant role', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    const msg = makeMessage({ isBot: true, content: 'I am bot.' })
    const deps = createFakeDeps()

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    const assistantMsg = messages.find(m => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toBe('I am bot.')
  })

  test('Group Summary 以 <group_summary> 包裹出現在 system prompt', async () => {
    const { sqlite, db } = setupTestDb()
    sqlite.exec(`INSERT INTO group_summaries(id, summary, updated_at) VALUES('singleton','聊天室主要討論技術',${Date.now()})`)
    const config = makeConfig()
    const deps = createFakeDeps()

    const messages = await assembleContext({
      recentMessages: [],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    expect(messages[0].content).toContain('<group_summary>')
    expect(messages[0].content).toContain('聊天室主要討論技術')
    expect(messages[0].content).toContain('</group_summary>')
  })

  test('User Summaries 以 <user_profiles> 包裹出現在 system prompt', async () => {
    const { sqlite, db } = setupTestDb()
    sqlite.exec(`INSERT INTO user_summaries(id, user_id, summary, updated_at) VALUES('us1','user1','Alice 是工程師',${Date.now()})`)
    const config = makeConfig()
    const msg = makeMessage({ userId: 'user1' })
    const deps = createFakeDeps()

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    expect(messages[0].content).toContain('<user_profiles>')
    expect(messages[0].content).toContain('Alice 是工程師')
    expect(messages[0].content).toContain('</user_profiles>')
  })

  test('Token budget 超支 → 裁剪語義搜尋（sqlite-vec 未初始化，語義搜尋 throw 被 catch 攔截）', async () => {
    const { sqlite, db } = setupTestDb()
    const deps = createFakeDeps()

    const soul = 'S' // 極短 SOUL
    const config = makeConfig({ CONTEXT_MAX_TOKENS: 5, SOUL: soul })
    const msg = makeMessage({ content: 'Hi' })

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // system prompt 應不含語義搜尋結果
    expect(messages[0].content).not.toContain('<related_history>')
  })

  test('訊息順序：舊訊息在前', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    const deps = createFakeDeps()
    const older = makeMessage({ timestamp: 1000, content: 'first', userId: 'u1' })
    const newer = makeMessage({ timestamp: 2000, content: 'second', userId: 'u1' })

    // getRecentMessages 回傳 desc，所以 recentMessages = [newer, older]
    const messages = await assembleContext({
      recentMessages: [newer, older],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // 兩則連續 user 訊息會合併為一則
    const userMsgs = messages.filter(m => m.role === 'user')
    expect(userMsgs.length).toBe(1)
    expect(userMsgs[0].content).toBe('u1: first\nu1: second')
  })
})

describe('buildChatMessages', () => {
  test('連續 user 訊息合併為單一 user message', () => {
    const msgs: StoredMessage[] = [
      makeMessage({ userId: 'u1', content: '早安', isBot: false, timestamp: 1000 }),
      makeMessage({ userId: 'u2', content: '安安', isBot: false, timestamp: 2000 }),
      makeMessage({ userId: 'u3', content: '嗨', isBot: false, timestamp: 3000 }),
    ]

    const result = buildChatMessages(msgs)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('u1: 早安\nu2: 安安\nu3: 嗨')
  })

  test('user/assistant 交替正確', () => {
    const msgs: StoredMessage[] = [
      makeMessage({ userId: 'u1', content: '哈囉', isBot: false, timestamp: 1000 }),
      makeMessage({ userId: 'u2', content: '你好', isBot: false, timestamp: 2000 }),
      makeMessage({ content: '大家好！', isBot: true, timestamp: 3000 }),
      makeMessage({ userId: 'u1', content: '今天天氣不錯', isBot: false, timestamp: 4000 }),
    ]

    const result = buildChatMessages(msgs)
    expect(result.length).toBe(3)
    expect(result[0]).toEqual({ role: 'user', content: 'u1: 哈囉\nu2: 你好' })
    expect(result[1]).toEqual({ role: 'assistant', content: '大家好！' })
    expect(result[2]).toEqual({ role: 'user', content: 'u1: 今天天氣不錯' })
  })

  test('空陣列 → 空結果', () => {
    expect(buildChatMessages([])).toEqual([])
  })

  test('只有 bot 訊息 → 全部 assistant', () => {
    const msgs: StoredMessage[] = [
      makeMessage({ content: '嗨', isBot: true, timestamp: 1000 }),
      makeMessage({ content: '再見', isBot: true, timestamp: 2000 }),
    ]

    const result = buildChatMessages(msgs)
    expect(result.length).toBe(2)
    expect(result.every(m => m.role === 'assistant')).toBe(true)
  })
})
