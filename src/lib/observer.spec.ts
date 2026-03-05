import type { Database } from 'bun:sqlite'
import type { Config } from '../config/index.ts'
import type { ObserverDeps } from './observer'
import { describe, expect, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { getDistinctUserIds, getMessagesByUser, getMessagesSince } from '../storage/messages'
import { buildGroupCompressionPrompt } from '../prompts/observer'
import { processNewFactEmbeddings } from '../storage/embedding'
import {
  getAllActiveFacts,
  getFactWatermark,
  getPinnedFacts,
  setFactWatermark,
  supersedeFact,
  upsertFact,
} from '../storage/facts'
import {
  getGroupSummary,
  getUserSummary,
  upsertGroupSummary,
  upsertUserSummary,
} from '../storage/summaries'
import { extractFacts } from './fact-extractor.ts'
import {
  compressGroupSummary,
  compressUserSummaries,

  runObserver,
  shouldRun,
} from './observer'

function makeConfig(threshold = 5): Config {
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
    OBSERVER_MESSAGE_THRESHOLD: threshold,
    OBSERVER_USER_MESSAGE_LIMIT: 50,
  })
}

function insertMessage(sqlite: Database, overrides: {
  externalId?: string
  userId?: string
  content?: string
  isBot?: boolean
  timestamp?: number
} = {}) {
  const ts = overrides.timestamp ?? Date.now()
  sqlite.prepare(
    `INSERT INTO messages(external_id, user_id, content, is_bot, timestamp)
     VALUES(?, ?, ?, ?, ?)`,
  ).run(
    overrides.externalId ?? null,
    overrides.userId ?? 'user1',
    overrides.content ?? 'Hello',
    overrides.isBot ? 1 : 0,
    ts,
  )
}

/** 建立可注入的假依賴，generateWithFallback 預設回傳固定文字 */
function createFakeDeps(llmResponse = 'fake summary') {
  const generateCalls: string[] = []

  const deps: ObserverDeps = {
    getMessagesSince,
    getMessagesByUser,
    getDistinctUserIds,
    extractFacts,
    upsertFact,
    supersedeFact,
    getAllActiveFacts,
    getPinnedFacts,
    getFactWatermark,
    setFactWatermark,
    processNewFactEmbeddings,
    generateWithFallback: async (prompt: string) => {
      generateCalls.push(prompt)
      return llmResponse
    },
    getGroupSummary,
    upsertGroupSummary,
    getUserSummary,
    upsertUserSummary,
    getAliasMap: async () => new Map<string, { alias: string; userName: string }>(),
  }

  return { deps, generateCalls }
}

describe('shouldRun', () => {
  test('訊息數 < threshold → false', () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(5)
    insertMessage(sqlite, { content: 'm1' })
    insertMessage(sqlite, { content: 'm2' })
    expect(shouldRun(db, config)).toBe(false)
  })

  test('訊息數 >= threshold → true', () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(3)
    insertMessage(sqlite, { content: 'm1' })
    insertMessage(sqlite, { content: 'm2' })
    insertMessage(sqlite, { content: 'm3' })
    expect(shouldRun(db, config)).toBe(true)
  })

  test('threshold 邊界：訊息數恰好 = threshold → true', () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(5)
    insertMessage(sqlite, { content: 'm1' })
    insertMessage(sqlite, { content: 'm2' })
    insertMessage(sqlite, { content: 'm3' })
    insertMessage(sqlite, { content: 'm4' })
    insertMessage(sqlite, { content: 'm5' })
    expect(shouldRun(db, config)).toBe(true)
  })

  test('首次壓縮（無 group_summaries）：watermark=0，計算全部訊息', () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(3)
    // 插入 3 則訊息，無 group_summaries 記錄
    insertMessage(sqlite, { content: 'm1' })
    insertMessage(sqlite, { content: 'm2' })
    insertMessage(sqlite, { content: 'm3' })
    // 應該計算全部 3 則訊息 → shouldRun true
    expect(shouldRun(db, config)).toBe(true)
  })

  test('增量壓縮：只計算 watermark 之後的新訊息', () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(2)
    // 插入舊訊息
    const oldTs = Date.now() - 10000
    insertMessage(sqlite, { content: 'm1', timestamp: oldTs })
    insertMessage(sqlite, { content: 'm2', timestamp: oldTs + 1 })
    // 插入 group summary，watermark = oldTs + 5000（在兩則舊訊息之後）
    const watermarkTs = oldTs + 5000
    sqlite.prepare(
      `INSERT INTO group_summaries(id, summary, updated_at) VALUES(?, ?, ?)`,
    ).run('gs1', 'Old summary', watermarkTs)
    // 插入新訊息（在 watermark 之後）
    insertMessage(sqlite, { content: 'm3', timestamp: watermarkTs + 1 })
    insertMessage(sqlite, { content: 'm4', timestamp: watermarkTs + 2 })
    // 只有 2 則新訊息 >= threshold(2) → shouldRun true
    expect(shouldRun(db, config)).toBe(true)
  })

  test('壓縮後（group summary 存在且 updatedAt 夠新）→ false', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(3)
    // 插入 3 則舊訊息
    const oldTs = Date.now() - 10000
    insertMessage(sqlite, { content: 'm1', timestamp: oldTs })
    insertMessage(sqlite, { content: 'm2', timestamp: oldTs + 1 })
    insertMessage(sqlite, { content: 'm3', timestamp: oldTs + 2 })
    // 插入 group summary，updatedAt 比所有訊息新
    const nowTs = Date.now()
    sqlite.prepare(
      `INSERT INTO group_summaries(id, summary, updated_at) VALUES(?, ?, ?)`,
    ).run('gs1', 'Some summary', nowTs)
    // 新訊息數 = 0（所有訊息都比 summary 舊）→ shouldRun false
    expect(shouldRun(db, config)).toBe(false)
  })
})

describe('compressGroupSummary', () => {
  test('AI 被呼叫一次，摘要被儲存', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    insertMessage(sqlite, { content: 'Hello world' })
    const { deps, generateCalls } = createFakeDeps('compressed group summary')

    await compressGroupSummary(db, 0, config, deps)

    expect(generateCalls.length).toBe(1)
    const stored = await getGroupSummary(db)
    expect(stored).toBe('compressed group summary')
  })

  test('增量壓縮：prompt 只包含 watermark 之後的訊息', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    // 插入舊訊息
    const oldTs = Date.now() - 10000
    insertMessage(sqlite, { userId: 'u1', content: 'old msg 1', timestamp: oldTs })
    insertMessage(sqlite, { userId: 'u1', content: 'old msg 2', timestamp: oldTs + 1 })
    // 插入 group summary，watermark = oldTs + 5000
    const watermarkTs = oldTs + 5000
    sqlite.prepare(
      `INSERT INTO group_summaries(id, summary, updated_at) VALUES(?, ?, ?)`,
    ).run('gs1', 'Old summary', watermarkTs)
    // 插入新訊息（在 watermark 之後）
    insertMessage(sqlite, { userId: 'u1', content: 'new msg 1', timestamp: watermarkTs + 1 })
    insertMessage(sqlite, { userId: 'u1', content: 'new msg 2', timestamp: watermarkTs + 2 })

    const { deps, generateCalls } = createFakeDeps('incremental summary')

    await compressGroupSummary(db, watermarkTs, config, deps)

    // prompt 應包含新訊息但不含舊訊息
    expect(generateCalls.length).toBe(1)
    expect(generateCalls[0]).toContain('new msg 1')
    expect(generateCalls[0]).toContain('new msg 2')
    expect(generateCalls[0]).not.toContain('old msg 1')
    expect(generateCalls[0]).not.toContain('old msg 2')
  })
})

describe('compressUserSummaries', () => {
  test('每個 user 各呼叫一次 AI，摘要被正確儲存', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    insertMessage(sqlite, { userId: 'u1', content: 'msg from u1' })
    insertMessage(sqlite, { userId: 'u2', content: 'msg from u2' })

    let callIndex = 0
    const { deps } = createFakeDeps()
    deps.generateWithFallback = async () => {
      callIndex++
      return `user summary ${callIndex}`
    }

    await compressUserSummaries(db, 0, ['u1', 'u2'], config, deps)

    const u1Summary = await getUserSummary(db, 'u1')
    const u2Summary = await getUserSummary(db, 'u2')
    expect(u1Summary).toBe('user summary 1')
    expect(u2Summary).toBe('user summary 2')
    expect(callIndex).toBe(2)
  })
})

describe('runObserver', () => {
  test('shouldRun false → AI 不被呼叫', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(10) // threshold = 10
    const { deps, generateCalls } = createFakeDeps()
    // 只有 2 則訊息
    insertMessage(sqlite, { content: 'm1' })
    insertMessage(sqlite, { content: 'm2' })

    await runObserver(db, sqlite, config, deps)

    expect(generateCalls.length).toBe(0)
  })

  test('shouldRun true → 完整流程：group summary + user summaries 皆被儲存', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(2) // threshold = 2
    const { deps, generateCalls } = createFakeDeps()
    // fact extraction 需要 mock，否則真正呼叫 extractFacts 會失敗
    deps.extractFacts = (async () => []) as unknown as ObserverDeps['extractFacts']
    deps.processNewFactEmbeddings = (async () => {}) as unknown as ObserverDeps['processNewFactEmbeddings']

    insertMessage(sqlite, { userId: 'u1', content: 'hello' })
    insertMessage(sqlite, { userId: 'u2', content: 'world' })

    await runObserver(db, sqlite, config, deps)

    // 3 次 LLM 呼叫：1 group summary + 2 user summaries
    expect(generateCalls.length).toBe(3)
    const storedGroupSummary = await getGroupSummary(db)
    expect(storedGroupSummary).toBe('fake summary')
    const u1Summary = await getUserSummary(db, 'u1')
    const u2Summary = await getUserSummary(db, 'u2')
    expect(u1Summary).toBe('fake summary')
    expect(u2Summary).toBe('fake summary')
  })

  test('Bot 訊息不被列入 user summaries', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(1)
    const { deps, generateCalls } = createFakeDeps()
    deps.extractFacts = (async () => []) as unknown as ObserverDeps['extractFacts']
    deps.processNewFactEmbeddings = (async () => {}) as unknown as ObserverDeps['processNewFactEmbeddings']

    insertMessage(sqlite, { userId: 'u1', isBot: false, content: 'user msg' })
    insertMessage(sqlite, { userId: 'bot', isBot: true, content: 'bot msg' })

    await runObserver(db, sqlite, config, deps)

    // 只有 u1 是非 bot，所以 2 次 LLM 呼叫：1 group + 1 user (u1)
    expect(generateCalls.length).toBe(2)
    const u1Summary = await getUserSummary(db, 'u1')
    expect(u1Summary).toBe('fake summary')
    // bot 不應該有摘要
    const botSummary = await getUserSummary(db, 'bot')
    expect(botSummary).toBeNull()
  })

  test('只有 bot 訊息達 threshold → userIds 為空 → 跳過 user summaries', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(2) // threshold = 2
    const { deps, generateCalls } = createFakeDeps()
    deps.extractFacts = (async () => []) as unknown as ObserverDeps['extractFacts']
    deps.processNewFactEmbeddings = (async () => {}) as unknown as ObserverDeps['processNewFactEmbeddings']

    // 只插入 bot 訊息
    insertMessage(sqlite, { userId: 'bot', isBot: true, content: 'bot msg 1' })
    insertMessage(sqlite, { userId: 'bot', isBot: true, content: 'bot msg 2' })

    await runObserver(db, sqlite, config, deps)

    // 只有 1 次 group summary LLM 呼叫，無 user summaries
    expect(generateCalls.length).toBe(1)
  })
})

describe('fact extraction integration', () => {
  test('runObserver: extractFacts 成功 → upsertFact 和 setFactWatermark 被呼叫', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(2) // threshold = 2
    insertMessage(sqlite, { userId: 'u1', content: 'hello', isBot: false })
    insertMessage(sqlite, { userId: 'u2', content: 'world', isBot: false })

    let upsertFactCalled = false
    let setFactWatermarkCalled = false

    const { deps } = createFakeDeps()
    const testDeps: ObserverDeps = {
      ...deps,
      extractFacts: (async () => [{
        action: 'insert' as const,
        scope: 'group' as const,
        canonicalKey: 'test_fact',
        content: 'test',
        confidence: 0.9,
      }]) as unknown as ObserverDeps['extractFacts'],
      upsertFact: (...args) => {
        upsertFactCalled = true
        return upsertFact(...args)
      },
      setFactWatermark: (...args) => {
        setFactWatermarkCalled = true
        return setFactWatermark(...args)
      },
      processNewFactEmbeddings: (async () => {}) as unknown as ObserverDeps['processNewFactEmbeddings'],
    }

    await runObserver(db, sqlite, config, testDeps)

    expect(upsertFactCalled).toBe(true)
    expect(setFactWatermarkCalled).toBe(true)
  })

  test('runObserver: extractFacts 拋錯不中斷摘要壓縮', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(2)
    insertMessage(sqlite, { userId: 'u1', content: 'hello', isBot: false })
    insertMessage(sqlite, { userId: 'u2', content: 'world', isBot: false })

    let setFactWatermarkCalled = false

    const { deps, generateCalls } = createFakeDeps()
    const testDeps: ObserverDeps = {
      ...deps,
      extractFacts: (async () => { throw new Error('Fact extraction error') }) as unknown as ObserverDeps['extractFacts'],
      setFactWatermark: (...args) => {
        setFactWatermarkCalled = true
        return setFactWatermark(...args)
      },
      processNewFactEmbeddings: (async () => {}) as unknown as ObserverDeps['processNewFactEmbeddings'],
    }

    await runObserver(db, sqlite, config, testDeps)

    // extractFacts 拋錯 → try block 中的 setFactWatermark 不被呼叫
    expect(setFactWatermarkCalled).toBe(false)
    // compressGroupSummary + compressUserSummaries 仍被執行
    expect(generateCalls.length).toBeGreaterThan(0)
  })

  test('compressGroupSummary 傳入 pinnedFacts → prompt 包含「不要重複」', () => {
    // buildGroupCompressionPrompt 是 compressGroupSummary 內部使用的 prompt builder
    // 直接驗證 prompt builder 輸出，確保 pinnedFacts 被正確注入
    const prompt = buildGroupCompressionPrompt(null, 'some chat history', 'Alice 養了一隻貓')
    expect(prompt).toContain('不要重複')
    expect(prompt).toContain('Alice 養了一隻貓')
  })
})
