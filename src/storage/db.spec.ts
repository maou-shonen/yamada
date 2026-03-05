import { rmSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'
import { GroupDbManager, openGroupDb } from './db'
import { messages } from './schema'

const TEST_DB_DIR = `/tmp/test-db-${Date.now()}`
const TEST_DIMENSIONS = 4

afterEach(() => {
  try {
    rmSync(TEST_DB_DIR, { recursive: true, force: true })
  }
  catch {}
})

describe('openGroupDb', () => {
  test('建立 DB 並初始化 schema', () => {
    const { db, sqlite } = openGroupDb(TEST_DB_DIR, 'group-a', TEST_DIMENSIONS)
    expect(db).toBeDefined()
    expect(sqlite).toBeDefined()
    sqlite.close()
  })

  test('insert + query messages', async () => {
    const { db, sqlite } = openGroupDb(TEST_DB_DIR, 'group-a', TEST_DIMENSIONS)
    const now = Date.now()

    await db.insert(messages).values({
      externalId: 'msg-1',
      userId: 'user-1',
      content: 'Hello world',
      isBot: false,
      timestamp: now,
    })

    const result = await db.select().from(messages)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Hello world')
    sqlite.close()
  })
})

describe('GroupDbManager', () => {
  test('getOrCreate 回傳相同實例', () => {
    const manager = new GroupDbManager(TEST_DB_DIR, TEST_DIMENSIONS)
    const db1 = manager.getOrCreate('group-a')
    const db2 = manager.getOrCreate('group-a')
    expect(db1).toBe(db2)
    manager.closeAll()
  })

  test('不同 groupId 回傳不同實例', () => {
    const manager = new GroupDbManager(TEST_DB_DIR, TEST_DIMENSIONS)
    const dbA = manager.getOrCreate('group-a')
    const dbB = manager.getOrCreate('group-b')
    expect(dbA).not.toBe(dbB)
    manager.closeAll()
  })

  test('per-group 隔離：group-a 的資料在 group-b 不可見', async () => {
    const manager = new GroupDbManager(TEST_DB_DIR, TEST_DIMENSIONS)
    const { db: dbA } = manager.getOrCreate('group-a')
    const { db: dbB } = manager.getOrCreate('group-b')
    const now = Date.now()

    await dbA.insert(messages).values({
      externalId: 'msg-a',
      userId: 'user-1',
      content: 'Message in group A',
      isBot: false,
      timestamp: now,
    })

    const groupAMessages = await dbA.select().from(messages)
    const groupBMessages = await dbB.select().from(messages)

    expect(groupAMessages).toHaveLength(1)
    expect(groupBMessages).toHaveLength(0)

    manager.closeAll()
  })

  test('closeAll 關閉所有連線', () => {
    const manager = new GroupDbManager(TEST_DB_DIR, TEST_DIMENSIONS)
    manager.getOrCreate('group-a')
    manager.getOrCreate('group-b')
    expect(() => manager.closeAll()).not.toThrow()
  })
})
