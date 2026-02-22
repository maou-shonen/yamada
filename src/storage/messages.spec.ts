import type { UnifiedMessage } from '../types'
import { expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import {
  getMessageCount,
  getMessagesByUser,
  getMessagesSince,
  getRecentMessages,
  saveBotMessage,
  saveMessage,
} from './messages'

function makeDb() {
  return setupTestDb()
}

test('saveMessage - 儲存訊息並驗證內容', () => {
  const { db } = makeDb()
  const now = new Date()

  const message: UnifiedMessage = {
    id: 'msg-1',
    groupId: 'group-a',
    userId: 'user-1',
    userName: 'Alice',
    content: 'Hello world',
    timestamp: now,
    platform: 'discord',
    isBot: false,
    isMention: false,
  }

  saveMessage(db, message)

  const stored = getRecentMessages(db, 10)
  expect(stored).toHaveLength(1)
  expect(stored[0].content).toBe('Hello world')
  expect(stored[0].userId).toBe('user-1')
  expect(stored[0].isBot).toBe(false)
})

test('saveBotMessage - 儲存機器人訊息並驗證 isBot=true', () => {
  const { db } = makeDb()

  saveBotMessage(db, 'Bot response')

  const stored = getRecentMessages(db, 10)
  expect(stored).toHaveLength(1)
  expect(stored[0].content).toBe('Bot response')
  expect(stored[0].isBot).toBe(true)
  expect(stored[0].userId).toBe('bot')
})

test('getRecentMessages - 取得最近訊息並按時間倒序', () => {
  const { db } = makeDb()
  const baseTime = new Date('2024-01-01T00:00:00Z')

  // 插入多個訊息
  for (let i = 0; i < 5; i++) {
    const message: UnifiedMessage = {
      id: `msg-${i}`,
      groupId: 'group-a',
      userId: 'user-1',
      userName: 'Alice',
      content: `Message ${i}`,
      timestamp: new Date(baseTime.getTime() + i * 1000),
      platform: 'discord',
      isBot: false,
      isMention: false,
    }
    saveMessage(db, message)
  }

  const recent = getRecentMessages(db, 3)
  expect(recent).toHaveLength(3)
  // 應該按時間倒序（最新的在前）
  expect(recent[0].content).toBe('Message 4')
  expect(recent[1].content).toBe('Message 3')
  expect(recent[2].content).toBe('Message 2')
})

test('getMessagesSince - 取得指定時間之後的訊息', () => {
  const { db } = makeDb()
  const baseTime = new Date('2024-01-01T00:00:00Z')

  // 插入訊息
  for (let i = 0; i < 5; i++) {
    const message: UnifiedMessage = {
      id: `msg-${i}`,
      groupId: 'group-a',
      userId: 'user-1',
      userName: 'Alice',
      content: `Message ${i}`,
      timestamp: new Date(baseTime.getTime() + i * 1000),
      platform: 'discord',
      isBot: false,
      isMention: false,
    }
    saveMessage(db, message)
  }

  // 取得 2024-01-01T00:00:02Z 之後的訊息
  const since = new Date(baseTime.getTime() + 2000)
  const messages = getMessagesSince(db, since)

  expect(messages).toHaveLength(2)
  expect(messages[0].content).toBe('Message 4')
  expect(messages[1].content).toBe('Message 3')
})

test('getMessagesByUser - 取得特定使用者的訊息', () => {
  const { db } = makeDb()
  const now = new Date()

  // 插入多個使用者的訊息
  const message1: UnifiedMessage = {
    id: 'msg-1',
    groupId: 'group-a',
    userId: 'user-1',
    userName: 'Alice',
    content: 'Alice message 1',
    timestamp: now,
    platform: 'discord',
    isBot: false,
    isMention: false,
  }

  const message2: UnifiedMessage = {
    id: 'msg-2',
    groupId: 'group-a',
    userId: 'user-2',
    userName: 'Bob',
    content: 'Bob message 1',
    timestamp: new Date(now.getTime() + 1000),
    platform: 'discord',
    isBot: false,
    isMention: false,
  }

  const message3: UnifiedMessage = {
    id: 'msg-3',
    groupId: 'group-a',
    userId: 'user-1',
    userName: 'Alice',
    content: 'Alice message 2',
    timestamp: new Date(now.getTime() + 2000),
    platform: 'discord',
    isBot: false,
    isMention: false,
  }

  saveMessage(db, message1)
  saveMessage(db, message2)
  saveMessage(db, message3)

  const aliceMessages = getMessagesByUser(db, 'user-1', 10)
  expect(aliceMessages).toHaveLength(2)
  expect(aliceMessages[0].content).toBe('Alice message 2')
  expect(aliceMessages[1].content).toBe('Alice message 1')

  const bobMessages = getMessagesByUser(db, 'user-2', 10)
  expect(bobMessages).toHaveLength(1)
  expect(bobMessages[0].content).toBe('Bob message 1')
})

test('getMessageCount - 計算訊息總數', () => {
  const { db } = makeDb()
  const now = new Date()

  for (let i = 0; i < 3; i++) {
    const message: UnifiedMessage = {
      id: `msg-a-${i}`,
      groupId: 'group-a',
      userId: 'user-1',
      userName: 'Alice',
      content: `Message ${i}`,
      timestamp: new Date(now.getTime() + i * 1000),
      platform: 'discord',
      isBot: false,
      isMention: false,
    }
    saveMessage(db, message)
  }

  expect(getMessageCount(db)).toBe(3)
})

test('混合操作 - 儲存、查詢、計數', () => {
  const { db } = makeDb()
  const now = new Date()

  // 儲存使用者訊息
  const userMessage: UnifiedMessage = {
    id: 'msg-1',
    groupId: 'group-a',
    userId: 'user-1',
    userName: 'Alice',
    content: 'User message',
    timestamp: now,
    platform: 'discord',
    isBot: false,
    isMention: false,
  }
  saveMessage(db, userMessage)

  // 儲存機器人訊息
  saveBotMessage(db, 'Bot response')

  // 驗證總數
  expect(getMessageCount(db)).toBe(2)

  // 驗證最近訊息
  const recent = getRecentMessages(db, 10)
  expect(recent).toHaveLength(2)

  // 驗證有一個 bot 訊息和一個使用者訊息
  const botMessages = recent.filter(m => m.isBot)
  const userMessages = recent.filter(m => !m.isBot)
  expect(botMessages).toHaveLength(1)
  expect(userMessages).toHaveLength(1)
  expect(botMessages[0].content).toBe('Bot response')
  expect(userMessages[0].content).toBe('User message')

  // 驗證使用者訊息
  const userMsgs = getMessagesByUser(db, 'user-1', 10)
  expect(userMsgs).toHaveLength(1)
  expect(userMsgs[0].content).toBe('User message')
})

test('時間戳精度 - 毫秒級別', () => {
  const { db } = makeDb()
  const now = new Date('2024-01-01T12:34:56.789Z')

  const message: UnifiedMessage = {
    id: 'msg-1',
    groupId: 'group-a',
    userId: 'user-1',
    userName: 'Alice',
    content: 'Test message',
    timestamp: now,
    platform: 'discord',
    isBot: false,
    isMention: false,
  }

  saveMessage(db, message)

  const stored = getRecentMessages(db, 10)
  expect(stored[0].timestamp).toBe(now.getTime())
})
