import type { Database } from 'bun:sqlite'
import type { Config } from '../config/index.ts'
import type { ObserverDeps } from './observer'
import { describe, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { getDistinctUserIds, getMessagesByUser, getMessagesSince } from '../storage/messages'
import {
  getGroupSummary,
  getUserSummary,
  upsertGroupSummary,
  upsertUserSummary,
} from '../storage/summaries'
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

function createFakeDeps() {
  const generateTextMock = mock(() => Promise.resolve({ text: 'AI output' }))

  const deps: ObserverDeps = {
    generateText: generateTextMock as unknown as ObserverDeps['generateText'],
    createModel: (modelName: string) => ({ model: modelName }) as unknown as ReturnType<ObserverDeps['createModel']>,
    getMessagesSince,
    getMessagesByUser,
    getDistinctUserIds,
    getGroupSummary,
    upsertGroupSummary,
    getUserSummary,
    upsertUserSummary,
  }

  return {
    deps,
    generateTextMock,
  }
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
    const { deps, generateTextMock } = createFakeDeps()
    generateTextMock.mockImplementation(() => Promise.resolve({ text: 'Group summary text' }))

    await compressGroupSummary(db, 0, config, deps)

    expect(generateTextMock.mock.calls.length).toBe(1)

    // 驗證 group summary 被儲存
    const saved = await getGroupSummary(db)
    expect(saved).toBe('Group summary text')
  })
})

describe('compressUserSummaries', () => {
  test('每個 user 各呼叫一次 AI', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig()
    insertMessage(sqlite, { userId: 'u1', content: 'msg from u1' })
    insertMessage(sqlite, { userId: 'u2', content: 'msg from u2' })
    const { deps, generateTextMock } = createFakeDeps()
    generateTextMock.mockImplementation(() => Promise.resolve({ text: 'User summary' }))

    await compressUserSummaries(db, 0, ['u1', 'u2'], config, deps)

    expect(generateTextMock.mock.calls.length).toBe(2)

    const s1 = await getUserSummary(db, 'u1')
    const s2 = await getUserSummary(db, 'u2')
    expect(s1).toBe('User summary')
    expect(s2).toBe('User summary')
  })
})

describe('runObserver', () => {
  test('shouldRun false → AI 不被呼叫', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(10) // threshold = 10
    const { deps, generateTextMock } = createFakeDeps()
    // 只有 2 則訊息
    insertMessage(sqlite, { content: 'm1' })
    insertMessage(sqlite, { content: 'm2' })

    await runObserver(db, config, deps)

    expect(generateTextMock.mock.calls.length).toBe(0)
  })

  test('shouldRun true → 完整流程：group summary + user summaries', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(2) // threshold = 2
    const { deps, generateTextMock } = createFakeDeps()
    insertMessage(sqlite, { userId: 'u1', content: 'hello' })
    insertMessage(sqlite, { userId: 'u2', content: 'world' })

    await runObserver(db, config, deps)

    // 1 次 group summary + 2 次 user summaries = 3 次
    expect(generateTextMock.mock.calls.length).toBe(3)

    const gs = await getGroupSummary(db)
    const u1 = await getUserSummary(db, 'u1')
    const u2 = await getUserSummary(db, 'u2')
    expect(gs).toBe('AI output')
    expect(u1).toBe('AI output')
    expect(u2).toBe('AI output')
  })

  test('Bot 訊息不被列入 user summaries', async () => {
    const { sqlite, db } = setupTestDb()
    const config = makeConfig(1)
    const { deps, generateTextMock } = createFakeDeps()
    insertMessage(sqlite, { userId: 'u1', isBot: false, content: 'user msg' })
    insertMessage(sqlite, { userId: 'bot', isBot: true, content: 'bot msg' })

    await runObserver(db, config, deps)

    // 1 group + 1 user (u1 only, bot excluded) = 2
    expect(generateTextMock.mock.calls.length).toBe(2)
  })
})
