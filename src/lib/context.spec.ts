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
    replyToExternalId: null,
    ...overrides,
  }
}

function createFakeDeps(): ContextDeps {
  return {
    getUserSummariesForGroup,
    getGroupSummary,
    embedText: (async () => [0.1, 0.2, 0.3]) as unknown as ContextDeps['embedText'],
    searchSimilarChunks: (() => []) as unknown as ContextDeps['searchSimilarChunks'],
    getChunkContents: (() => []) as unknown as ContextDeps['getChunkContents'],
    getAliasMap: (async () => new Map()) as unknown as ContextDeps['getAliasMap'],
    getPinnedFacts: (() => []) as unknown as ContextDeps['getPinnedFacts'],
    getGroupFacts: (() => []) as unknown as ContextDeps['getGroupFacts'],
    searchSimilarFacts: (() => []) as unknown as ContextDeps['searchSimilarFacts'],
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

  test('Token budget 裁剪優先序：先移除語義搜尋，保留用戶摘要', async () => {
    const { sqlite, db } = setupTestDb()
    // 插入用戶摘要
    sqlite.exec(`INSERT INTO user_summaries(id, user_id, summary, updated_at) VALUES('us1','user1','Alice 是工程師',${Date.now()})`)
    // 插入群組摘要
    sqlite.exec(`INSERT INTO group_summaries(id, summary, updated_at) VALUES('singleton','聊天室主要討論技術',${Date.now()})`)

    // 設定 SOUL 和 CONTEXT_MAX_TOKENS 使得移除語義搜尋後剛好符合預算
    const soul = 'S'.repeat(50) // 50 chars
    const config = makeConfig({
      SOUL: soul,
      CONTEXT_MAX_TOKENS: 60, // 預算緊張，移除語義搜尋後剛好符合
      embeddingEnabled: true,
    })

    // 設定 deps：語義搜尋回傳結果
    const deps = {
      ...createFakeDeps(),
      searchSimilarChunks: (() => [{ chunkId: 'chunk-1', distance: 0.5 }]) as unknown as ContextDeps['searchSimilarChunks'],
      getChunkContents: (() => ['Some relevant history content here']) as unknown as ContextDeps['getChunkContents'],
    }

    const msg = makeMessage({ userId: 'user1', content: 'Hi there' })

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // 驗證：system prompt 含 <user_profiles> 但不含 <related_history>
    expect(messages[0].content).toContain('<user_profiles>')
    expect(messages[0].content).toContain('Alice 是工程師')
    expect(messages[0].content).not.toContain('<related_history>')
  })

  test('Token budget 全部超支 → 語義搜尋和用戶摘要都被裁剪', async () => {
    const { sqlite, db } = setupTestDb()
    // 插入用戶摘要
    sqlite.exec(`INSERT INTO user_summaries(id, user_id, summary, updated_at) VALUES('us1','user1','Alice 是工程師',${Date.now()})`)
    // 插入群組摘要
    sqlite.exec(`INSERT INTO group_summaries(id, summary, updated_at) VALUES('singleton','聊天室主要討論技術',${Date.now()})`)

    // 設定極小的 CONTEXT_MAX_TOKENS 使得兩個都被裁剪
    const soul = 'S'.repeat(100)
    const config = makeConfig({
      SOUL: soul,
      CONTEXT_MAX_TOKENS: 50, // 非常小，兩個都會被裁剪
      embeddingEnabled: true,
    })

    // 設定 deps：語義搜尋回傳結果
    const deps = {
      ...createFakeDeps(),
      searchSimilarChunks: (() => [{ chunkId: 'chunk-1', distance: 0.5 }]) as unknown as ContextDeps['searchSimilarChunks'],
      getChunkContents: (() => ['Some relevant history content here']) as unknown as ContextDeps['getChunkContents'],
    }

    const msg = makeMessage({ userId: 'user1', content: 'Hi there' })

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // 驗證：system prompt 不含 <user_profiles> 和 <related_history>，但含 <soul>
    expect(messages[0].content).not.toContain('<user_profiles>')
    expect(messages[0].content).not.toContain('<related_history>')
    expect(messages[0].content).toContain('<soul>')
  })

  test('語義搜尋回傳 0 結果 → system prompt 不含 <related_history>', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig({ embeddingEnabled: true })

    // 設定 deps：語義搜尋回傳空陣列
    const deps = {
      ...createFakeDeps(),
      searchSimilarChunks: (() => []) as unknown as ContextDeps['searchSimilarChunks'],
    }

    const msg = makeMessage({ content: 'Hi' })

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // 驗證：system prompt 不含 <related_history>
    expect(messages[0].content).not.toContain('<related_history>')
  })

  test('語義搜尋 throw → 降級繼續，system prompt 不含 <related_history>', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig({ embeddingEnabled: true })

    // 設定 deps：embedText throw
    const deps = {
      ...createFakeDeps(),
      embedText: (async () => {
        throw new Error('Embedding service down')
      }) as unknown as ContextDeps['embedText'],
    }

    const msg = makeMessage({ content: 'Hi' })

    // 驗證：assembleContext 不 throw，正常返回
    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0].content).not.toContain('<related_history>')
  })

  test('embeddingEnabled=false → 跳過語義搜尋', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig({ embeddingEnabled: false })

    // 設定 deps：embedText 會被呼叫時 throw（驗證它不被呼叫）
    let embedTextCalled = false
    const deps = {
      ...createFakeDeps(),
      embedText: (async () => {
        embedTextCalled = true
        throw new Error('Should not be called')
      }) as unknown as ContextDeps['embedText'],
    }

    const msg = makeMessage({ content: 'Hi' })

    const messages = await assembleContext({
      recentMessages: [msg],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // 驗證：embedText 未被呼叫，system prompt 不含 <related_history>
    expect(embedTextCalled).toBe(false)
    expect(messages[0].content).not.toContain('<related_history>')
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

describe('facts injection', () => {
  function makeFact(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      scope: 'group',
      userId: null,
      canonicalKey: 'weekly_dinner',
      content: '群組每週五聚餐',
      confidence: 0.9,
      evidenceCount: 1,
      status: 'active',
      pinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    }
  }

  test('Pinned group fact 注入 → system prompt 包含 <group_facts>', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    const pinnedFact = makeFact()

    const deps: ContextDeps = {
      ...createFakeDeps(),
      getGroupFacts: (() => [pinnedFact]) as unknown as ContextDeps['getGroupFacts'],
    }

    const messages = await assembleContext({
      recentMessages: [makeMessage({ userId: 'u1', content: 'Hi' })],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    expect(messages[0].content).toContain('<group_facts>')
    expect(messages[0].content).toContain('群組每週五聚餐')
    expect(messages[0].content).toContain('</group_facts>')
  })

  test('embeddingEnabled=false → 只有 pinned facts，不呼叫 searchSimilarFacts', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig({ embeddingEnabled: false })
    const pinnedFact = makeFact()

    let searchSimilarFactsCalled = false
    const deps: ContextDeps = {
      ...createFakeDeps(),
      getGroupFacts: (() => [pinnedFact]) as unknown as ContextDeps['getGroupFacts'],
      searchSimilarFacts: ((..._args: unknown[]) => {
        searchSimilarFactsCalled = true
        return []
      }) as unknown as ContextDeps['searchSimilarFacts'],
    }

    const messages = await assembleContext({
      recentMessages: [makeMessage({ userId: 'u1', content: 'Hi' })],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    expect(searchSimilarFactsCalled).toBe(false)
    expect(messages[0].content).toContain('<group_facts>')
    expect(messages[0].content).toContain('群組每週五聚餐')
  })

  test('Token trimming：searched facts 先於 pinned facts 被裁剪', async () => {
    const { sqlite, db } = setupTestDb()

    const pinnedFact = makeFact({ id: 1, content: 'pinned fact', pinned: true })
    const searchableFact = makeFact({ id: 2, content: 'searched fact', pinned: false })

    // SOUL='S' → <soul>\nS\n</soul> = 16 chars
    // groupFacts with both: <group_facts>\npinned fact\nsearched fact\n</group_facts> = 54 chars
    // Total with both: 70 chars → ceil(70/3) = 24 tokens
    // groupFacts pinned only: <group_facts>\npinned fact\n</group_facts> = 40 chars
    // Total without searched: 56 chars → ceil(56/3) = 19 tokens
    const config = makeConfig({
      SOUL: 'S',
      CONTEXT_MAX_TOKENS: 22,
      CONTEXT_TOKEN_ESTIMATE_RATIO: 3,
      embeddingEnabled: true,
    })

    const deps: ContextDeps = {
      ...createFakeDeps(),
      getGroupFacts: (() => [pinnedFact, searchableFact]) as unknown as ContextDeps['getGroupFacts'],
      searchSimilarFacts: (() => [{ factId: 2, distance: 0.5 }]) as unknown as ContextDeps['searchSimilarFacts'],
    }

    const messages = await assembleContext({
      recentMessages: [makeMessage({ userId: 'u1', content: 'Hi' })],
      config,
      db,
      sqliteDb: sqlite,
      deps,
    })

    // pinned fact 保留、searched fact 被裁剪
    expect(messages[0].content).toContain('pinned fact')
    expect(messages[0].content).not.toContain('searched fact')
  })
})
