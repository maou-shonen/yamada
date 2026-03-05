import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { closeDb, openDb } from './db'
import { messages } from './schema'

const TEST_DB_PATH = join(tmpdir(), `test-yamada-${Date.now()}.db`)
const TEST_DIMENSIONS = 4

afterEach(() => {
  try { rmSync(TEST_DB_PATH, { force: true }) } catch {}
  try { rmSync(`${TEST_DB_PATH}-wal`, { force: true }) } catch {}
  try { rmSync(`${TEST_DB_PATH}-shm`, { force: true }) } catch {}
})

describe('openDb', () => {
  test('建立 DB 並初始化 schema', () => {
    const appDb = openDb(TEST_DB_PATH, TEST_DIMENSIONS)
    expect(appDb.db).toBeDefined()
    expect(appDb.sqlite).toBeDefined()
    closeDb(appDb)
  })

  test('WAL mode 啟用', () => {
    const appDb = openDb(TEST_DB_PATH, TEST_DIMENSIONS)
    const result = appDb.sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(result.journal_mode).toBe('wal')
    closeDb(appDb)
  })

  test('busy_timeout 設定為 10000', () => {
    const appDb = openDb(TEST_DB_PATH, TEST_DIMENSIONS)
    const result = appDb.sqlite.query('PRAGMA busy_timeout').get() as { timeout: number }
    expect(result.timeout).toBe(10000)
    closeDb(appDb)
  })

  test('insert + query messages with groupId', async () => {
    const appDb = openDb(TEST_DB_PATH, TEST_DIMENSIONS)
    const now = Date.now()

    await appDb.db.insert(messages).values({
      groupId: 'group-a',
      externalId: 'msg-1',
      userId: 'user-1',
      content: 'Hello world',
      isBot: false,
      timestamp: now,
    })

    const result = await appDb.db.select().from(messages)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Hello world')
    expect(result[0].groupId).toBe('group-a')
    closeDb(appDb)
  })

  test('cross-group isolation via groupId filter', async () => {
    const appDb = openDb(TEST_DB_PATH, TEST_DIMENSIONS)
    const now = Date.now()

    await appDb.db.insert(messages).values({
      groupId: 'group-a',
      externalId: 'msg-a',
      userId: 'user-1',
      content: 'Message in group A',
      isBot: false,
      timestamp: now,
    })

    const groupAMessages = await appDb.db.select().from(messages).where(eq(messages.groupId, 'group-a'))
    const groupBMessages = await appDb.db.select().from(messages).where(eq(messages.groupId, 'group-b'))

    expect(groupAMessages).toHaveLength(1)
    expect(groupBMessages).toHaveLength(0)
    closeDb(appDb)
  })
})

describe('closeDb', () => {
  test('關閉後 query 應拋出錯誤', () => {
    const appDb = openDb(TEST_DB_PATH, TEST_DIMENSIONS)
    closeDb(appDb)

    expect(() => {
      appDb.sqlite.query('SELECT 1').get()
    }).toThrow()
  })
})
