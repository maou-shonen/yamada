import { describe, expect, test } from 'bun:test'
import { getAliasMap, getAllAliases, getOrCreateAlias } from './user-aliases'
import { setupTestDb } from '../__tests__/helpers/setup-db'

describe('user-aliases CRUD', () => {
  test('首次建立 alias', async () => {
    const { db } = setupTestDb()
    const result = await getOrCreateAlias(db, 'U123', 'Alice')
    expect(result.alias).toMatch(/^user_[a-z]+_[a-z]+$/)
    expect(result.userName).toBe('Alice')
  })

  test('重複呼叫回傳同一 alias（穩定性）', async () => {
    const { db } = setupTestDb()
    const first = await getOrCreateAlias(db, 'U123', 'Alice')
    const second = await getOrCreateAlias(db, 'U123', 'Alice')
    expect(first.alias).toBe(second.alias)
  })

  test('重複呼叫更新 userName', async () => {
    const { db } = setupTestDb()
    await getOrCreateAlias(db, 'U123', 'Alice')
    const updated = await getOrCreateAlias(db, 'U123', 'Alice_NewName')
    expect(updated.userName).toBe('Alice_NewName')
  })

  test('bot userId 直接回傳 bot alias', async () => {
    const { db } = setupTestDb()
    const result = await getOrCreateAlias(db, 'bot', 'Bot')
    expect(result.alias).toBe('bot')
  })

  test('getAliasMap 批量查詢', async () => {
    const { db } = setupTestDb()
    await getOrCreateAlias(db, 'U123', 'Alice')
    await getOrCreateAlias(db, 'U456', 'Bob')
    const map = await getAliasMap(db, ['U123', 'U456'])
    expect(map.size).toBe(2)
    expect(map.get('U123')?.userName).toBe('Alice')
    expect(map.get('U456')?.userName).toBe('Bob')
  })

  test('getAliasMap 空陣列回傳空 Map', async () => {
    const { db } = setupTestDb()
    const map = await getAliasMap(db, [])
    expect(map.size).toBe(0)
  })

  test('getAllAliases 回傳所有 alias', async () => {
    const { db } = setupTestDb()
    await getOrCreateAlias(db, 'U123', 'Alice')
    await getOrCreateAlias(db, 'U456', 'Bob')
    const aliases = getAllAliases(db)
    expect(aliases.size).toBe(2)
  })
})
