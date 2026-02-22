import { expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import {
  getGroupSummary,
  getUserSummariesForGroup,
  getUserSummary,
  upsertGroupSummary,
  upsertUserSummary,
} from './summaries'

function makeDb() {
  return setupTestDb()
}

test('getUserSummary - 不存在的摘要回傳 null', async () => {
  const { db } = makeDb()

  const result = await getUserSummary(db, 'user-1')

  expect(result).toBeNull()
})

test('upsertUserSummary - 新增用戶摘要', async () => {
  const { db } = makeDb()

  await upsertUserSummary(db, 'user-1', 'Alice is friendly')

  const result = await getUserSummary(db, 'user-1')

  expect(result).toBe('Alice is friendly')
})

test('upsertUserSummary - 更新用戶摘要', async () => {
  const { db } = makeDb()

  // 第一次插入
  await upsertUserSummary(db, 'user-1', 'Alice is friendly')
  let result = await getUserSummary(db, 'user-1')
  expect(result).toBe('Alice is friendly')

  // 第二次更新（同一 userId）
  await upsertUserSummary(db, 'user-1', 'Alice is very friendly')
  result = await getUserSummary(db, 'user-1')

  expect(result).toBe('Alice is very friendly')
})

test('getGroupSummary - 不存在的群組摘要回傳 null', async () => {
  const { db } = makeDb()

  const result = await getGroupSummary(db)

  expect(result).toBeNull()
})

test('upsertGroupSummary - 新增群組摘要', async () => {
  const { db } = makeDb()

  await upsertGroupSummary(db, 'Group A is about tech')

  const result = await getGroupSummary(db)

  expect(result).toBe('Group A is about tech')
})

test('upsertGroupSummary - 更新群組摘要', async () => {
  const { db } = makeDb()

  // 第一次插入
  await upsertGroupSummary(db, 'Group A is about tech')
  let result = await getGroupSummary(db)
  expect(result).toBe('Group A is about tech')

  // 第二次更新
  await upsertGroupSummary(db, 'Group A is about tech and gaming')
  result = await getGroupSummary(db)

  expect(result).toBe('Group A is about tech and gaming')
})

test('getUserSummariesForGroup - 空用戶列表回傳空 Map', async () => {
  const { db } = makeDb()

  const result = await getUserSummariesForGroup(db, [])

  expect(result.size).toBe(0)
})

test('getUserSummariesForGroup - 批次查詢多個用戶摘要', async () => {
  const { db } = makeDb()

  // 新增多個用戶的摘要
  await upsertUserSummary(db, 'user-1', 'Alice is friendly')
  await upsertUserSummary(db, 'user-2', 'Bob is quiet')
  await upsertUserSummary(db, 'user-3', 'Charlie is talkative')

  // 批次查詢
  const result = await getUserSummariesForGroup(db, [
    'user-1',
    'user-2',
    'user-3',
  ])

  expect(result.size).toBe(3)
  expect(result.get('user-1')).toBe('Alice is friendly')
  expect(result.get('user-2')).toBe('Bob is quiet')
  expect(result.get('user-3')).toBe('Charlie is talkative')
})

test('getUserSummariesForGroup - 只回傳存在的用戶摘要', async () => {
  const { db } = makeDb()

  // 只新增 user-1 和 user-2 的摘要
  await upsertUserSummary(db, 'user-1', 'Alice is friendly')
  await upsertUserSummary(db, 'user-2', 'Bob is quiet')

  // 查詢包含不存在的 user-3
  const result = await getUserSummariesForGroup(db, [
    'user-1',
    'user-2',
    'user-3',
  ])

  expect(result.size).toBe(2)
  expect(result.get('user-1')).toBe('Alice is friendly')
  expect(result.get('user-2')).toBe('Bob is quiet')
  expect(result.get('user-3')).toBeUndefined()
})

test('upsertUserSummary - 更新時保持 userId 唯一性', async () => {
  const { sqlite, db } = makeDb()

  // 第一次插入
  await upsertUserSummary(db, 'user-1', 'First summary')

  // 第二次更新（應該成功，不拋出唯一性約束錯誤）
  await upsertUserSummary(db, 'user-1', 'Updated summary')

  // 驗證只有一筆記錄
  const count = sqlite
    .query('SELECT COUNT(*) as cnt FROM user_summaries WHERE user_id = ?')
    .all('user-1') as Array<{ cnt: number }>

  expect(count[0].cnt).toBe(1)
})

test('upsertGroupSummary - 更新時保持唯一性', async () => {
  const { sqlite, db } = makeDb()

  // 第一次插入
  await upsertGroupSummary(db, 'First summary')

  // 第二次更新（應該成功，不拋出唯一性約束錯誤）
  await upsertGroupSummary(db, 'Updated summary')

  // 驗證只有一筆記錄
  const count = sqlite
    .query('SELECT COUNT(*) as cnt FROM group_summaries')
    .all() as Array<{ cnt: number }>

  expect(count[0].cnt).toBe(1)
})

test('updatedAt - 每次 upsert 都更新時間戳', async () => {
  const { sqlite, db } = makeDb()

  // 第一次插入
  await upsertUserSummary(db, 'user-1', 'First summary')
  const first = await getUserSummary(db, 'user-1')
  expect(first).toBe('First summary')

  // 等待一小段時間
  await new Promise(resolve => setTimeout(resolve, 10))

  // 第二次更新
  await upsertUserSummary(db, 'user-1', 'Updated summary')

  // 驗證 updatedAt 已更新
  const rows = sqlite
    .query('SELECT updated_at FROM user_summaries WHERE user_id = ?')
    .all('user-1') as Array<{ updated_at: number }>

  expect(rows).toHaveLength(1)
  expect(rows[0].updated_at).toBeGreaterThan(0)
})
