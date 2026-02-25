import type { UnifiedMessage } from '../types'
import { expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { saveMessage } from './messages'
import {
  countActiveMembers,
  countMessagesSince,
  getFrequencyState,
  saveFrequencyState,
  type FrequencyState,
} from './frequency-stats'

function makeDb() {
  return setupTestDb()
}

/** 建立測試用的人類訊息 */
function makeMessage(overrides: { id: string; timestamp: number } & Omit<Partial<UnifiedMessage>, 'id' | 'timestamp'>): UnifiedMessage {
  return {
    groupId: 'group-a',
    userId: 'user-1',
    userName: 'Alice',
    content: 'Hello',
    platform: 'discord',
    isBot: false,
    isMention: false,
    ...overrides,
    id: overrides.id,
    timestamp: new Date(overrides.timestamp),
  }
}

/** 建立測試用的 bot 訊息 */
function makeBotMessage(id: string, timestamp: number): UnifiedMessage {
  return {
    id,
    groupId: 'group-a',
    userId: 'bot',
    userName: 'Bot',
    content: 'Bot reply',
    platform: 'discord',
    isBot: true,
    isMention: false,
    timestamp: new Date(timestamp),
  }
}

// ─── getFrequencyState ───────────────────────────────────────────────────────

test('getFrequencyState - 空 DB 回傳 undefined', () => {
  const { db } = makeDb()
  expect(getFrequencyState(db)).toBeUndefined()
})

// ─── saveFrequencyState + getFrequencyState ──────────────────────────────────

test('saveFrequencyState - 首次儲存後可以讀回正確值', () => {
  const { db } = makeDb()

  const state: FrequencyState = {
    emaLongBot: 0.5,
    emaLongTotal: 2.0,
    emaShortBot: 0.1,
    emaShortTotal: 1.0,
    lastUpdatedAt: 1000000,
  }

  saveFrequencyState(db, state)

  const saved = getFrequencyState(db)
  expect(saved).toBeDefined()
  expect(saved?.emaLongBot).toBe(0.5)
  expect(saved?.emaLongTotal).toBe(2.0)
  expect(saved?.emaShortBot).toBe(0.1)
  expect(saved?.emaShortTotal).toBe(1.0)
  expect(saved?.lastUpdatedAt).toBe(1000000)
})

test('saveFrequencyState - singleton：第二次儲存覆蓋第一次，DB 只有一筆 row', () => {
  const { db } = makeDb()

  const first: FrequencyState = {
    emaLongBot: 0.3,
    emaLongTotal: 1.5,
    emaShortBot: 0.05,
    emaShortTotal: 0.8,
    lastUpdatedAt: 111111,
  }

  const second: FrequencyState = {
    emaLongBot: 0.7,
    emaLongTotal: 3.0,
    emaShortBot: 0.2,
    emaShortTotal: 1.5,
    lastUpdatedAt: 222222,
  }

  saveFrequencyState(db, first)
  saveFrequencyState(db, second)

  const saved = getFrequencyState(db)
  // 確認值是第二次的
  expect(saved?.emaLongBot).toBe(0.7)
  expect(saved?.emaLongTotal).toBe(3.0)
  expect(saved?.emaShortBot).toBe(0.2)
  expect(saved?.emaShortTotal).toBe(1.5)
  expect(saved?.lastUpdatedAt).toBe(222222)
})

test('saveFrequencyState - 浮點數精度保留', () => {
  const { db } = makeDb()

  const state: FrequencyState = {
    emaLongBot: 0.123456789,
    emaLongTotal: 9.987654321,
    emaShortBot: 0.000001,
    emaShortTotal: 999.999,
    lastUpdatedAt: 1740000000000,
  }

  saveFrequencyState(db, state)

  const saved = getFrequencyState(db)
  // SQLite REAL 為 64-bit IEEE 754，應保留足夠精度
  expect(saved?.emaLongBot).toBeCloseTo(0.123456789, 6)
  expect(saved?.emaLongTotal).toBeCloseTo(9.987654321, 6)
  expect(saved?.emaShortBot).toBeCloseTo(0.000001, 8)
  expect(saved?.emaShortTotal).toBeCloseTo(999.999, 3)
  expect(saved?.lastUpdatedAt).toBe(1740000000000)
})

test('saveFrequencyState - 全 0 預設狀態', () => {
  const { db } = makeDb()

  const state: FrequencyState = {
    emaLongBot: 0,
    emaLongTotal: 0,
    emaShortBot: 0,
    emaShortTotal: 0,
    lastUpdatedAt: 0,
  }

  saveFrequencyState(db, state)

  const saved = getFrequencyState(db)
  expect(saved?.emaLongBot).toBe(0)
  expect(saved?.emaLongTotal).toBe(0)
  expect(saved?.emaShortBot).toBe(0)
  expect(saved?.emaShortTotal).toBe(0)
  expect(saved?.lastUpdatedAt).toBe(0)
})

// ─── countMessagesSince ──────────────────────────────────────────────────────

test('countMessagesSince - 空 DB 回傳 { total: 0, bot: 0 }', () => {
  const { db } = makeDb()
  const result = countMessagesSince(db, 0)
  expect(result.total).toBe(0)
  expect(result.bot).toBe(0)
})

test('countMessagesSince - 計算 since 之後的人類訊息數，bot = 0', () => {
  const { db } = makeDb()
  const base = 1_000_000

  // 3 則在 since 之後
  for (let i = 0; i < 3; i++) {
    saveMessage(db, makeMessage({ id: `msg-${i}`, timestamp: base + 1000 + i * 1000 }))
  }
  // 1 則在 since 之前，不應計入
  saveMessage(db, makeMessage({ id: 'msg-old', timestamp: base - 1000 }))

  const result = countMessagesSince(db, base)
  expect(result.total).toBe(3)
  expect(result.bot).toBe(0)
})

test('countMessagesSince - bot 訊息計入 total 和 bot', () => {
  const { db } = makeDb()
  const base = 1_000_000

  // 2 則人類訊息
  saveMessage(db, makeMessage({ id: 'u1', timestamp: base + 1000 }))
  saveMessage(db, makeMessage({ id: 'u2', userId: 'user-2', timestamp: base + 2000 }))

  // 1 則 bot 訊息
  saveMessage(db, makeBotMessage('bot-1', base + 3000))

  const result = countMessagesSince(db, base)
  expect(result.total).toBe(3)
  expect(result.bot).toBe(1)
})

test('countMessagesSince - 多則 bot 訊息', () => {
  const { db } = makeDb()
  const base = 1_000_000

  saveMessage(db, makeMessage({ id: 'u1', timestamp: base + 1000 }))
  saveMessage(db, makeBotMessage('bot-1', base + 2000))
  saveMessage(db, makeBotMessage('bot-2', base + 3000))
  saveMessage(db, makeBotMessage('bot-3', base + 4000))

  const result = countMessagesSince(db, base)
  expect(result.total).toBe(4)
  expect(result.bot).toBe(3)
})

test('countMessagesSince - 邊界值：timestamp 等於 since 不計入（gt，嚴格大於）', () => {
  const { db } = makeDb()
  const ts = 1_000_000

  saveMessage(db, makeMessage({ id: 'exact', timestamp: ts }))

  // since = ts（等於），gt 不包含等於
  const result = countMessagesSince(db, ts)
  expect(result.total).toBe(0)
})

test('countMessagesSince - since 之前的訊息全部排除', () => {
  const { db } = makeDb()
  const base = 1_000_000

  for (let i = 0; i < 5; i++) {
    saveMessage(db, makeMessage({ id: `old-${i}`, timestamp: base - 1000 - i * 1000 }))
  }

  const result = countMessagesSince(db, base)
  expect(result.total).toBe(0)
  expect(result.bot).toBe(0)
})

// ─── countActiveMembers ──────────────────────────────────────────────────────

test('countActiveMembers - 空 DB 回傳 0', () => {
  const { db } = makeDb()
  expect(countActiveMembers(db, 0)).toBe(0)
})

test('countActiveMembers - 計算 since 之後的活躍人數（不含 bot）', () => {
  const { db } = makeDb()
  const base = 1_000_000

  // user-1 發 2 則（只算 1 人）
  saveMessage(db, makeMessage({ id: 'u1-1', userId: 'user-1', timestamp: base + 1000 }))
  saveMessage(db, makeMessage({ id: 'u1-2', userId: 'user-1', timestamp: base + 2000 }))

  // user-2 發 1 則
  saveMessage(db, makeMessage({ id: 'u2-1', userId: 'user-2', timestamp: base + 3000 }))

  // user-old 在 since 之前，不應計入
  saveMessage(db, makeMessage({ id: 'old', userId: 'user-old', timestamp: base - 1000 }))

  expect(countActiveMembers(db, base)).toBe(2)
})

test('countActiveMembers - bot 訊息不計入活躍人數', () => {
  const { db } = makeDb()
  const base = 1_000_000

  saveMessage(db, makeMessage({ id: 'u1', userId: 'user-1', timestamp: base + 1000 }))
  saveMessage(db, makeBotMessage('bot-1', base + 2000))

  expect(countActiveMembers(db, base)).toBe(1)
})

test('countActiveMembers - 同一用戶多則訊息只算一次', () => {
  const { db } = makeDb()
  const base = 1_000_000

  for (let i = 0; i < 5; i++) {
    saveMessage(db, makeMessage({ id: `msg-${i}`, userId: 'user-1', timestamp: base + 1000 + i * 1000 }))
  }

  expect(countActiveMembers(db, base)).toBe(1)
})

test('countActiveMembers - 多個用戶各別計算', () => {
  const { db } = makeDb()
  const base = 1_000_000

  const users = ['alice', 'bob', 'carol', 'dave']
  for (const [i, userId] of users.entries()) {
    saveMessage(db, makeMessage({ id: `m-${i}`, userId, timestamp: base + 1000 + i * 1000 }))
  }

  expect(countActiveMembers(db, base)).toBe(4)
})

test('countActiveMembers - 邊界值：timestamp 等於 since 不計入（gt）', () => {
  const { db } = makeDb()
  const ts = 1_000_000

  saveMessage(db, makeMessage({ id: 'exact', userId: 'user-1', timestamp: ts }))

  expect(countActiveMembers(db, ts)).toBe(0)
})
