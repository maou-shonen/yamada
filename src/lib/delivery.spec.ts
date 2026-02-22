import type { PlatformChannel } from '../types'
import { expect, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { deliverReaction, deliverReply } from './delivery'

interface MockResult {
  channel: PlatformChannel
  sendMessageCalls: Array<[string, string]>
  sendReactionCalls: Array<[string, string, string]>
  setSendMessageError: (error: Error | null) => void
  setSendReactionError: (error: Error | null) => void
}

const config = createTestConfig()

/** 建立 mock PlatformChannel */
function makeMockChannel(): MockResult {
  const sendMessageCalls: Array<[string, string]> = []
  const sendReactionCalls: Array<[string, string, string]> = []
  let sendMessageError: Error | null = null
  let sendReactionError: Error | null = null

  const channel: PlatformChannel = {
    name: 'mock',
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendMessage: async (groupId: string, content: string) => {
      sendMessageCalls.push([groupId, content])
      if (sendMessageError)
        throw sendMessageError
    },
    sendReaction: async (groupId: string, messageId: string, emoji: string) => {
      sendReactionCalls.push([groupId, messageId, emoji])
      if (sendReactionError)
        throw sendReactionError
    },
  }

  return {
    channel,
    sendMessageCalls,
    sendReactionCalls,
    setSendMessageError: (error: Error | null) => {
      sendMessageError = error
    },
    setSendReactionError: (error: Error | null) => {
      sendReactionError = error
    },
  }
}

test('Discord: content 恰好 2000 chars → 不截斷', async () => {
  const content = 'a'.repeat(2000)
  const result = makeMockChannel()

  await deliverReply({
    channel: result.channel,
    groupId: 'group1',
    content,
    platform: 'discord',
    config,
  })

  expect(result.sendMessageCalls.length).toBe(1)
  expect(result.sendMessageCalls[0][0]).toBe('group1')
  expect(result.sendMessageCalls[0][1]).toBe(content)
})

test('Discord: content 2001 chars → 截斷到 2000（1997 + "..."）', async () => {
  const content = 'a'.repeat(2001)
  const result = makeMockChannel()

  await deliverReply({
    channel: result.channel,
    groupId: 'group1',
    content,
    platform: 'discord',
    config,
  })

  const expected = `${'a'.repeat(1997)}...`
  expect(result.sendMessageCalls.length).toBe(1)
  expect(result.sendMessageCalls[0][0]).toBe('group1')
  expect(result.sendMessageCalls[0][1]).toBe(expected)
})

test('LINE: content 恰好 5000 chars → 不截斷', async () => {
  const content = 'b'.repeat(5000)
  const result = makeMockChannel()

  await deliverReply({
    channel: result.channel,
    groupId: 'group2',
    content,
    platform: 'line',
    config,
  })

  expect(result.sendMessageCalls.length).toBe(1)
  expect(result.sendMessageCalls[0][0]).toBe('group2')
  expect(result.sendMessageCalls[0][1]).toBe(content)
})

test('LINE: content 5001 chars → 截斷到 5000（4997 + "..."）', async () => {
  const content = 'b'.repeat(5001)
  const result = makeMockChannel()

  await deliverReply({
    channel: result.channel,
    groupId: 'group2',
    content,
    platform: 'line',
    config,
  })

  const expected = `${'b'.repeat(4997)}...`
  expect(result.sendMessageCalls.length).toBe(1)
  expect(result.sendMessageCalls[0][0]).toBe('group2')
  expect(result.sendMessageCalls[0][1]).toBe(expected)
})

test('sendMessage 拋出錯誤 → deliverReply resolves（不 throw）', async () => {
  const error = new Error('Network error')
  const result = makeMockChannel()
  result.setSendMessageError(error)

  // 應該不 throw
  await expect(deliverReply({
    channel: result.channel,
    groupId: 'group1',
    content: 'test',
    platform: 'discord',
    config,
  })).resolves.toBeUndefined()
})

test('sendReaction 拋出錯誤 → deliverReaction resolves（不 throw）', async () => {
  const error = new Error('Reaction failed')
  const result = makeMockChannel()
  result.setSendReactionError(error)

  // 應該不 throw
  await expect(deliverReaction({
    channel: result.channel,
    groupId: 'group1',
    messageId: 'msg1',
    emoji: '👍',
  })).resolves.toBeUndefined()
})

test('deliverReaction 正常呼叫 sendReaction', async () => {
  const result = makeMockChannel()

  await deliverReaction({
    channel: result.channel,
    groupId: 'group1',
    messageId: 'msg123',
    emoji: '❤️',
  })

  expect(result.sendReactionCalls.length).toBe(1)
  expect(result.sendReactionCalls[0][0]).toBe('group1')
  expect(result.sendReactionCalls[0][1]).toBe('msg123')
  expect(result.sendReactionCalls[0][2]).toBe('❤️')
})
