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

  const result = await getUserSummary(db, 'group-a', 'user-1')

  expect(result).toBeNull()
})

test('upsertUserSummary - 新增用戶摘要', async () => {
  const { db } = makeDb()

  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice is friendly')

  const result = await getUserSummary(db, 'group-a', 'user-1')

  expect(result).toBe('Alice is friendly')
})

test('upsertUserSummary - 更新用戶摘要', async () => {
  const { db } = makeDb()

  // 第一次插入
  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice is friendly')
  let result = await getUserSummary(db, 'group-a', 'user-1')
  expect(result).toBe('Alice is friendly')

  // 第二次更新（同一 userId）
  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice is very friendly')
  result = await getUserSummary(db, 'group-a', 'user-1')

  expect(result).toBe('Alice is very friendly')
})

test('getGroupSummary - 不存在的群組摘要回傳 null', async () => {
  const { db } = makeDb()

  const result = await getGroupSummary(db, 'group-a')

  expect(result).toBeNull()
})

test('upsertGroupSummary - 新增群組摘要', async () => {
  const { db } = makeDb()

  await upsertGroupSummary(db, 'group-a', 'Group A is about tech')

  const result = await getGroupSummary(db, 'group-a')

  expect(result).toBe('Group A is about tech')
})

test('upsertGroupSummary - 更新群組摘要', async () => {
  const { db } = makeDb()

  // 第一次插入
  await upsertGroupSummary(db, 'group-a', 'Group A is about tech')
  let result = await getGroupSummary(db, 'group-a')
  expect(result).toBe('Group A is about tech')

  // 第二次更新
  await upsertGroupSummary(db, 'group-a', 'Group A is about tech and gaming')
  result = await getGroupSummary(db, 'group-a')

  expect(result).toBe('Group A is about tech and gaming')
})

test('getUserSummariesForGroup - 空用戶列表回傳空 Map', async () => {
  const { db } = makeDb()

  const result = await getUserSummariesForGroup(db, 'group-a', [])

  expect(result.size).toBe(0)
})

test('getUserSummariesForGroup - 批次查詢多個用戶摘要', async () => {
  const { db } = makeDb()

  // 新增多個用戶的摘要
  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice is friendly')
  await upsertUserSummary(db, 'group-a', 'user-2', 'Bob is quiet')
  await upsertUserSummary(db, 'group-a', 'user-3', 'Charlie is talkative')

  // 批次查詢
  const result = await getUserSummariesForGroup(db, 'group-a', [
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
  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice is friendly')
  await upsertUserSummary(db, 'group-a', 'user-2', 'Bob is quiet')

  // 查詢包含不存在的 user-3
  const result = await getUserSummariesForGroup(db, 'group-a', [
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
  await upsertUserSummary(db, 'group-a', 'user-1', 'First summary')

  // 第二次更新（應該成功，不拋出唯一性約束錯誤）
  await upsertUserSummary(db, 'group-a', 'user-1', 'Updated summary')

  // 驗證只有一筆記錄
  const count = sqlite
    .query('SELECT COUNT(*) as cnt FROM user_summaries WHERE user_id = ?')
    .all('user-1') as Array<{ cnt: number }>

  expect(count[0].cnt).toBe(1)
})

test('upsertGroupSummary - 更新時保持唯一性', async () => {
  const { sqlite, db } = makeDb()

  // 第一次插入
  await upsertGroupSummary(db, 'group-a', 'First summary')

  // 第二次更新（應該成功，不拋出唯一性約束錯誤）
  await upsertGroupSummary(db, 'group-a', 'Updated summary')

  // 驗證只有一筆記錄
  const count = sqlite
    .query('SELECT COUNT(*) as cnt FROM group_summaries')
    .all() as Array<{ cnt: number }>

  expect(count[0].cnt).toBe(1)
})

test('updatedAt - 每次 upsert 都更新時間戳', async () => {
  const { sqlite, db } = makeDb()

  // 第一次插入
  await upsertUserSummary(db, 'group-a', 'user-1', 'First summary')
  const first = await getUserSummary(db, 'group-a', 'user-1')
  expect(first).toBe('First summary')

  // 等待一小段時間
  await new Promise(resolve => setTimeout(resolve, 10))

  // 第二次更新
  await upsertUserSummary(db, 'group-a', 'user-1', 'Updated summary')

  // 驗證 updatedAt 已更新
  const rows = sqlite
    .query('SELECT updated_at FROM user_summaries WHERE user_id = ?')
    .all('user-1') as Array<{ updated_at: number }>

  expect(rows).toHaveLength(1)
  expect(rows[0].updated_at).toBeGreaterThan(0)
})

test('跨群組隔離 - 群組摘要獨立', async () => {
  const { db } = makeDb()

  // 在 group-a 中新增摘要
  await upsertGroupSummary(db, 'group-a', 'Group A is about tech')
  // 在 group-b 中新增摘要
  await upsertGroupSummary(db, 'group-b', 'Group B is about gaming')

  // 驗證各群組摘要獨立
  const resultA = await getGroupSummary(db, 'group-a')
  const resultB = await getGroupSummary(db, 'group-b')

  expect(resultA).toBe('Group A is about tech')
  expect(resultB).toBe('Group B is about gaming')
})

test('跨群組隔離 - 用戶摘要獨立', async () => {
  const { db } = makeDb()

  // 在 group-a 中新增 user-1 的摘要
  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice in group A')
  // 在 group-b 中新增 user-1 的摘要（不同內容）
  await upsertUserSummary(db, 'group-b', 'user-1', 'Alice in group B')

  // 驗證各群組中 user-1 的摘要獨立
  const resultA = await getUserSummary(db, 'group-a', 'user-1')
  const resultB = await getUserSummary(db, 'group-b', 'user-1')

  expect(resultA).toBe('Alice in group A')
  expect(resultB).toBe('Alice in group B')
})

test('跨群組隔離 - getUserSummariesForGroup 只回傳該群組的摘要', async () => {
  const { db } = makeDb()

  // 在 group-a 中新增多個用戶摘要
  await upsertUserSummary(db, 'group-a', 'user-1', 'Alice in A')
  await upsertUserSummary(db, 'group-a', 'user-2', 'Bob in A')

  // 在 group-b 中新增相同用戶的摘要
  await upsertUserSummary(db, 'group-b', 'user-1', 'Alice in B')
  await upsertUserSummary(db, 'group-b', 'user-3', 'Charlie in B')

  // 查詢 group-a 的摘要
  const resultA = await getUserSummariesForGroup(db, 'group-a', ['user-1', 'user-2', 'user-3'])
  // 查詢 group-b 的摘要
  const resultB = await getUserSummariesForGroup(db, 'group-b', ['user-1', 'user-2', 'user-3'])

  // group-a 應該只有 user-1 和 user-2
  expect(resultA.size).toBe(2)
  expect(resultA.get('user-1')).toBe('Alice in A')
  expect(resultA.get('user-2')).toBe('Bob in A')
  expect(resultA.get('user-3')).toBeUndefined()

  // group-b 應該只有 user-1 和 user-3
  expect(resultB.size).toBe(2)
  expect(resultB.get('user-1')).toBe('Alice in B')
  expect(resultB.get('user-2')).toBeUndefined()
  expect(resultB.get('user-3')).toBe('Charlie in B')
})
