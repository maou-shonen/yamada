import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * E2E 冒煙測試套件
 *
 * 核心價值：使用真實 file-based SQLite + 真實 sqlite-vector（非 mock），
 * 驗證完整資料流（per-group DB init → 儲存 → embedding → 搜尋 → observer 觸發條件）。
 *
 * 重要：此測試不 mock 'ai' 或 '@ai-sdk/openai' 套件，
 * 避免 Bun top-level mock 污染其他測試文件。
 * AI 相關功能（generateReply, assembleContext, runObserver）不在此測試範圍。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestConfig } from '../helpers/config.ts'

// ─── 直接 import 真實模組（無 mock）───

const { openGroupDb, GroupDbManager } = await import('../../storage/db')
const { saveChunk } = await import('../../storage/chunks')
const { saveMessage, getRecentMessages } = await import('../../storage/messages')
const { getGroupSummary, upsertGroupSummary } = await import('../../storage/summaries')
const { shouldRun } = await import('../../lib/observer')

// ─── 環境變數設定（loadConfig 從 process.env 讀取）───

const REQUIRED_ENV = {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
}

Object.assign(process.env, REQUIRED_ENV)

const { loadConfig } = await import('../../config/index')

// ─── 臨時目錄管理 ───

const TEST_DIMENSIONS = 1536

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'yamada-e2e-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ─── 輔助：確保 env vars 存在（某些測試會刪除再還原）───

function ensureEnv(): void {
  Object.assign(process.env, REQUIRED_ENV)
}

// ─── 測試場景 ───

describe('E2E 冒煙測試', () => {
  // ─── 場景 1: DB 完整性 — per-group DB init + vector tables ───
  test('DB 完整性：openGroupDb 建立所有 tables + vector tables 存在', async () => {
    const { sqlite, db, vectorStore } = openGroupDb(tmpDir, 'group-e2e', TEST_DIMENSIONS)

    // 驗證核心 tables 存在
    const tables = sqlite
      .prepare('SELECT name FROM sqlite_master WHERE type=\'table\'')
      .all() as { name: string }[]
    const tableNames = tables.map(t => t.name)
    expect(tableNames).toContain('messages')
    expect(tableNames).toContain('user_summaries')
    expect(tableNames).toContain('group_summaries')

    // 驗證 vector tables 存在（chunk_embeddings 和 fact_embeddings）
    expect(tableNames).toContain('chunk_embeddings')
    expect(tableNames).toContain('fact_embeddings')

    sqlite.close()
  })

  // ─── 場景 2: Config 驗證 ───
  test('Config 驗證：正確 env vars → 載入成功；缺少 env → 明確錯誤', () => {
    ensureEnv()

    // 正確 config 載入成功
    const config = loadConfig()
    expect(config).toBeDefined()
    expect(config.DEBOUNCE_SILENCE_MS).toBeGreaterThan(0)
    expect(config.CONTEXT_MAX_TOKENS).toBeGreaterThan(0)
    expect(config.OBSERVER_MESSAGE_THRESHOLD).toBeGreaterThan(0)

    // Discord 設定不完整 → discord 不啟用（不 throw）
    const savedToken = process.env.DISCORD_TOKEN
    delete process.env.DISCORD_TOKEN
    const partialConfig = loadConfig()
    expect(partialConfig.discordEnabled).toBe(false)
    process.env.DISCORD_TOKEN = savedToken
  })

  // ─── 場景 3: 訊息存取完整週期 — save → get → embedding → search ───
  test('訊息存取完整週期：save → get → embedding → search 結果一致', async () => {
    const { sqlite, db, vectorStore } = openGroupDb(tmpDir, 'group-a', TEST_DIMENSIONS)

    // 存入訊息
    const msg = {
      id: 'e2e-msg-1',
      groupId: 'group-a',
      userId: 'user-1',
      userName: 'Alice',
      content: '測試訊息內容',
      timestamp: new Date(),
      platform: 'discord' as const,
      isBot: false,
      isMention: false,
    }
    saveMessage(db, msg)

    // 取出訊息
    const msgs = getRecentMessages(db, 10)
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toBe('測試訊息內容')

    // 取得訊息的 integer id（用於 chunk 建立）
    const messageId = msgs[0].id
    const ts = msgs[0].timestamp

    // 建立 chunk 記錄（用於 chunk-based embedding）
    const chunkId = saveChunk(db, {
      content: '測試訊息內容',
      messageIds: [messageId],
      startTimestamp: ts,
      endTimestamp: ts,
    })

    // 插入 chunk 向量（固定向量，繞過 AI 呼叫）
    const embedding: number[] = Array.from({ length: 1536 }, () => 0.1)
    vectorStore.upsertChunkVector(chunkId, embedding)

    // 語義搜尋（threshold=2.0 放寬，確保同向量能找到）
    const results = vectorStore.searchChunks(embedding, 5, 2.0)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe(chunkId)

    sqlite.close()
  })

  // ─── 場景 4: per-group DB 隔離 ───
  test('per-group DB 隔離：group-a 的資料在 group-b 不可見', async () => {
    const manager = new GroupDbManager(tmpDir, TEST_DIMENSIONS)
    const { db: dbA } = manager.getOrCreate('group-a')
    const { db: dbB } = manager.getOrCreate('group-b')

    // 存入 group-a 的訊息
    saveMessage(dbA, {
      id: 'msg-a',
      groupId: 'group-a',
      userId: 'user-1',
      userName: 'Alice',
      content: 'group-a 訊息',
      timestamp: new Date(),
      platform: 'discord' as const,
      isBot: false,
      isMention: false,
    })

    // 存入 group-b 的訊息
    saveMessage(dbB, {
      id: 'msg-b',
      groupId: 'group-b',
      userId: 'user-2',
      userName: 'Bob',
      content: 'group-b 訊息',
      timestamp: new Date(),
      platform: 'discord' as const,
      isBot: false,
      isMention: false,
    })

    // group-a DB 只有 group-a 的訊息
    const msgsA = getRecentMessages(dbA, 10)
    expect(msgsA.length).toBe(1)
    expect(msgsA[0].content).toBe('group-a 訊息')

    // group-b DB 只有 group-b 的訊息
    const msgsB = getRecentMessages(dbB, 10)
    expect(msgsB.length).toBe(1)
    expect(msgsB[0].content).toBe('group-b 訊息')

    manager.closeAll()
  })

  // ─── 場景 5: Observer 觸發條件（不呼叫 AI）───
  test('Observer 觸發條件：訊息數超過 threshold → shouldRun 回傳 true', async () => {
    const { sqlite, db } = openGroupDb(tmpDir, 'group-obs', TEST_DIMENSIONS)

    ensureEnv()
    const config = createTestConfig({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: 'test-client-id',
      discordEnabled: true,
      DISCORD_GROUP_ID_MODE: 'guild',
      LINE_CHANNEL_SECRET: 'test-secret',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
      lineEnabled: true,
      LINE_WEBHOOK_PORT: 3000,
      OBSERVER_MESSAGE_THRESHOLD: 3,
      OBSERVER_USER_MESSAGE_LIMIT: 50,
    })
    const baseTs = Date.now() - 10_000

    // 存入 2 則訊息（< threshold）→ shouldRun 應為 false
    for (let i = 0; i < 2; i++) {
      saveMessage(db, {
        id: `obs-e2e-${i}`,
        groupId: 'group-obs',
        userId: `user-${i % 2}`,
        userName: i % 2 === 0 ? 'Alice' : 'Bob',
        content: `訊息 ${i}`,
        timestamp: new Date(baseTs + i * 1000),
        platform: 'discord' as const,
        isBot: false,
        isMention: false,
      })
    }
    expect(shouldRun(db, config)).toBe(false)

    // 再存入 2 則（共 4 則 >= threshold 3）→ shouldRun 應為 true
    for (let i = 2; i < 4; i++) {
      saveMessage(db, {
        id: `obs-e2e-${i}`,
        groupId: 'group-obs',
        userId: `user-${i % 2}`,
        userName: i % 2 === 0 ? 'Alice' : 'Bob',
        content: `訊息 ${i}`,
        timestamp: new Date(baseTs + i * 1000),
        platform: 'discord' as const,
        isBot: false,
        isMention: false,
      })
    }
    expect(shouldRun(db, config)).toBe(true)

    // 建立摘要後（模擬 observer 執行）→ shouldRun 應為 false
    await upsertGroupSummary(db, '群組摘要')
    expect(shouldRun(db, config)).toBe(false)

    sqlite.close()
  })
})
