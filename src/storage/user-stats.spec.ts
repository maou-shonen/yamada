import { expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import {
  getUserDailyStats,
  getUserStatsSince,
  recordActivity,
  type UserDailyStats,
  type UserStatsAggregate,
} from './user-stats'


test('recordActivity - 首次插入，計數正確', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: false,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats).toBeDefined()
  expect(stats?.messageCount).toBe(1)
  expect(stats?.stickerCount).toBe(0)
  expect(stats?.urlCount).toBe(0)
  expect(stats?.mentionCount).toBe(0)
})

test('recordActivity - 重複 UPSERT，messageCount 累加', () => {
  const { db } = setupTestDb()

  // 第一次記錄
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: false,
  })

  // 第二次記錄同用戶同日期
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: false,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(2)
  expect(stats?.stickerCount).toBe(0)
  expect(stats?.urlCount).toBe(0)
  expect(stats?.mentionCount).toBe(0)
})

test('recordActivity - isSticker=true 時，stickerCount +1', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(1)
  expect(stats?.stickerCount).toBe(1)
  expect(stats?.urlCount).toBe(0)
  expect(stats?.mentionCount).toBe(0)
})

test('recordActivity - hasUrl=true 時，urlCount +1', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: false,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(1)
  expect(stats?.stickerCount).toBe(0)
  expect(stats?.urlCount).toBe(1)
  expect(stats?.mentionCount).toBe(0)
})

test('recordActivity - isMention=true 時，mentionCount +1', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: true,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(1)
  expect(stats?.stickerCount).toBe(0)
  expect(stats?.urlCount).toBe(0)
  expect(stats?.mentionCount).toBe(1)
})

test('recordActivity - 不同用戶隔離', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: false,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-2',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  const stats1 = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  const stats2 = getUserDailyStats(db, 'group-a', 'user-2', '2024-01-01')

  expect(stats1?.messageCount).toBe(1)
  expect(stats1?.stickerCount).toBe(0)

  expect(stats2?.messageCount).toBe(1)
  expect(stats2?.stickerCount).toBe(1)
})

test('recordActivity - 不同日期隔離', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: false,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-02',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  const stats1 = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  const stats2 = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-02')

  expect(stats1?.messageCount).toBe(1)
  expect(stats1?.stickerCount).toBe(0)

  expect(stats2?.messageCount).toBe(1)
  expect(stats2?.stickerCount).toBe(1)
})

test('recordActivity - 混合分類：sticker + mention 同時為 true', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: true,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(1)
  expect(stats?.stickerCount).toBe(1)
  expect(stats?.urlCount).toBe(0)
  expect(stats?.mentionCount).toBe(1)
})

test('recordActivity - 混合分類：url + mention 同時為 true', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: true,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(1)
  expect(stats?.stickerCount).toBe(0)
  expect(stats?.urlCount).toBe(1)
  expect(stats?.mentionCount).toBe(1)
})

test('recordActivity - 多次 UPSERT，各計數獨立累加', () => {
  const { db } = setupTestDb()

  // 第一次：普通訊息
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: false,
    isMention: false,
  })

  // 第二次：貼圖訊息
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  // 第三次：URL + mention
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: true,
  })

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats?.messageCount).toBe(3)
  expect(stats?.stickerCount).toBe(1)
  expect(stats?.urlCount).toBe(1)
  expect(stats?.mentionCount).toBe(1)
})

test('getUserDailyStats - 不存在的記錄回傳 undefined', () => {
  const { db } = setupTestDb()

  const stats = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats).toBeUndefined()
})

test('getUserStatsSince - 單日累計', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: true,
  })

  const stats = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats.messageCount).toBe(2)
  expect(stats.stickerCount).toBe(1)
  expect(stats.urlCount).toBe(1)
  expect(stats.mentionCount).toBe(1)
})

test('getUserStatsSince - 多日累計', () => {
  const { db } = setupTestDb()

  // 2024-01-01
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  // 2024-01-02
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-02',
    isSticker: false,
    hasUrl: true,
    isMention: false,
  })

  // 2024-01-03
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-03',
    isSticker: false,
    hasUrl: false,
    isMention: true,
  })

  const stats = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats.messageCount).toBe(3)
  expect(stats.stickerCount).toBe(1)
  expect(stats.urlCount).toBe(1)
  expect(stats.mentionCount).toBe(1)
})

test('getUserStatsSince - 日期過濾正確', () => {
  const { db } = setupTestDb()

  // 2024-01-01
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  // 2024-01-02
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-02',
    isSticker: false,
    hasUrl: true,
    isMention: false,
  })

  // 2024-01-03
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-03',
    isSticker: false,
    hasUrl: false,
    isMention: true,
  })

  // 從 2024-01-02 開始
  const stats = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-02')
  expect(stats.messageCount).toBe(2)
  expect(stats.stickerCount).toBe(0)
  expect(stats.urlCount).toBe(1)
  expect(stats.mentionCount).toBe(1)
})

test('getUserStatsSince - 全期累計（遠古日期）', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-12-31',
    isSticker: false,
    hasUrl: true,
    isMention: true,
  })

  const stats = getUserStatsSince(db, 'group-a', 'user-1', '1970-01-01')
  expect(stats.messageCount).toBe(2)
  expect(stats.stickerCount).toBe(1)
  expect(stats.urlCount).toBe(1)
  expect(stats.mentionCount).toBe(1)
})

test('getUserStatsSince - 無資料回傳全 0', () => {
  const { db } = setupTestDb()

  const stats = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-01')
  expect(stats.messageCount).toBe(0)
  expect(stats.stickerCount).toBe(0)
  expect(stats.urlCount).toBe(0)
  expect(stats.mentionCount).toBe(0)
})

test('getUserStatsSince - 不同用戶隔離', () => {
  const { db } = setupTestDb()

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-2',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: false,
  })

  const stats1 = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-01')
  const stats2 = getUserStatsSince(db, 'group-a', 'user-2', '2024-01-01')

  expect(stats1.messageCount).toBe(1)
  expect(stats1.stickerCount).toBe(1)
  expect(stats1.urlCount).toBe(0)

  expect(stats2.messageCount).toBe(1)
  expect(stats2.stickerCount).toBe(0)
  expect(stats2.urlCount).toBe(1)
})

test('混合操作 - recordActivity + getUserDailyStats + getUserStatsSince', () => {
  const { db } = setupTestDb()

  // 記錄多個活動
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: true,
  })

  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-02',
    isSticker: false,
    hasUrl: false,
    isMention: true,
  })

  // 驗證每日統計
  const daily1 = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(daily1?.messageCount).toBe(2)
  expect(daily1?.stickerCount).toBe(1)
  expect(daily1?.urlCount).toBe(1)
  expect(daily1?.mentionCount).toBe(1)

  const daily2 = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-02')
  expect(daily2?.messageCount).toBe(1)
  expect(daily2?.stickerCount).toBe(0)
  expect(daily2?.urlCount).toBe(0)
  expect(daily2?.mentionCount).toBe(1)

  // 驗證累計統計
  const aggregate = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-01')
  expect(aggregate.messageCount).toBe(3)
  expect(aggregate.stickerCount).toBe(1)
  expect(aggregate.urlCount).toBe(1)
  expect(aggregate.mentionCount).toBe(2)
})

test('跨群組隔離 - 不同群組的統計互不污染', () => {
  const { db } = setupTestDb()

  // group-a 的活動
  recordActivity(db, 'group-a', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: true,
    hasUrl: false,
    isMention: false,
  })

  // group-b 的相同用戶、相同日期的活動
  recordActivity(db, 'group-b', {
    userId: 'user-1',
    date: '2024-01-01',
    isSticker: false,
    hasUrl: true,
    isMention: false,
  })

  // 驗證 group-a 的統計
  const statsA = getUserDailyStats(db, 'group-a', 'user-1', '2024-01-01')
  expect(statsA?.messageCount).toBe(1)
  expect(statsA?.stickerCount).toBe(1)
  expect(statsA?.urlCount).toBe(0)
  expect(statsA?.mentionCount).toBe(0)

  // 驗證 group-b 的統計
  const statsB = getUserDailyStats(db, 'group-b', 'user-1', '2024-01-01')
  expect(statsB?.messageCount).toBe(1)
  expect(statsB?.stickerCount).toBe(0)
  expect(statsB?.urlCount).toBe(1)
  expect(statsB?.mentionCount).toBe(0)

  // 驗證累計統計也隔離
  const aggregateA = getUserStatsSince(db, 'group-a', 'user-1', '2024-01-01')
  expect(aggregateA.messageCount).toBe(1)
  expect(aggregateA.stickerCount).toBe(1)
  expect(aggregateA.urlCount).toBe(0)

  const aggregateB = getUserStatsSince(db, 'group-b', 'user-1', '2024-01-01')
  expect(aggregateB.messageCount).toBe(1)
  expect(aggregateB.stickerCount).toBe(0)
  expect(aggregateB.urlCount).toBe(1)
})
