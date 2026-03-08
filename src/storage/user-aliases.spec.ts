import { describe, expect, test } from 'bun:test'
import { getAliasMap, getAllAliases, getOrCreateAlias } from './user-aliases'
import { setupTestDb } from '../__tests__/helpers/setup-db'

describe('user-aliases CRUD', () => {
  test('首次建立 alias', async () => {
    const { db } = setupTestDb()
    const result = await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    expect(result.alias).toMatch(/^user_[a-z]+_[a-z]+$/)
    expect(result.userName).toBe('Alice')
  })

  test('重複呼叫回傳同一 alias（穩定性）', async () => {
    const { db } = setupTestDb()
    const first = await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    const second = await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    expect(first.alias).toBe(second.alias)
  })

  test('重複呼叫更新 userName', async () => {
    const { db } = setupTestDb()
    await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    const updated = await getOrCreateAlias(db, 'group-a', 'U123', 'Alice_NewName')
    expect(updated.userName).toBe('Alice_NewName')
  })

  test('bot userId 直接回傳 bot alias', async () => {
    const { db } = setupTestDb()
    const result = await getOrCreateAlias(db, 'group-a', 'bot', 'Bot')
    expect(result.alias).toBe('bot')
  })

  test('getAliasMap 批量查詢', async () => {
    const { db } = setupTestDb()
    await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    await getOrCreateAlias(db, 'group-a', 'U456', 'Bob')
    const map = await getAliasMap(db, 'group-a', ['U123', 'U456'])
    expect(map.size).toBe(2)
    expect(map.get('U123')?.userName).toBe('Alice')
    expect(map.get('U456')?.userName).toBe('Bob')
  })

  test('getAliasMap 空陣列回傳空 Map', async () => {
    const { db } = setupTestDb()
    const map = await getAliasMap(db, 'group-a', [])
    expect(map.size).toBe(0)
  })

  test('getAllAliases 回傳指定群組的所有 alias', async () => {
    const { db } = setupTestDb()
    await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    await getOrCreateAlias(db, 'group-a', 'U456', 'Bob')
    const aliases = getAllAliases(db, 'group-a')
    expect(aliases.size).toBe(2)
  })

  test('跨群組隔離：同一 userId 在不同群組可有不同 alias', async () => {
    const { db } = setupTestDb()
    // 在 group-a 中建立 U123 的 alias
    const aliasA = await getOrCreateAlias(db, 'group-a', 'U123', 'Alice')
    // 在 group-b 中建立同一 userId 的 alias
    const aliasB = await getOrCreateAlias(db, 'group-b', 'U123', 'Alice')
    // 兩個 alias 應該不同（因為各群組的碰撞檢測是獨立的）
    expect(aliasA.alias).not.toBe(aliasB.alias)
    // 驗證 group-a 只有 1 個 alias
    const aliasesA = getAllAliases(db, 'group-a')
    expect(aliasesA.size).toBe(1)
    expect(aliasesA.has(aliasA.alias)).toBe(true)
    // 驗證 group-b 只有 1 個 alias
    const aliasesB = getAllAliases(db, 'group-b')
    expect(aliasesB.size).toBe(1)
    expect(aliasesB.has(aliasB.alias)).toBe(true)
    // 驗證 getAliasMap 也是群組隔離的
    const mapA = await getAliasMap(db, 'group-a', ['U123'])
    const mapB = await getAliasMap(db, 'group-b', ['U123'])
    expect(mapA.get('U123')?.alias).toBe(aliasA.alias)
    expect(mapB.get('U123')?.alias).toBe(aliasB.alias)
  })
})
