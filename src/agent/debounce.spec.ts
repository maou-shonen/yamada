import type { UnifiedMessage } from '../types'

import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { Debounce } from './debounce'

function makeMessage(content: string, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    groupId: overrides.groupId ?? 'group-1',
    userId: overrides.userId ?? 'user-1',
    userName: overrides.userName ?? '測試者',
    content,
    timestamp: overrides.timestamp ?? new Date(),
    platform: overrides.platform ?? 'discord',
    isBot: overrides.isBot ?? false,
    isMention: overrides.isMention ?? false,
    raw: overrides.raw,
  }
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

test('靜默觸發會將多則訊息合併觸發一次', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 3000 },
    onTrigger,
  )

  const first = makeMessage('第一則')
  const second = makeMessage('第二則')
  const third = makeMessage('第三則')

  debounce.push(first)
  debounce.push(second)
  debounce.push(third)

  expect(onTrigger).not.toHaveBeenCalled()

  jest.advanceTimersByTime(150)

  expect(onTrigger).toHaveBeenCalledTimes(1)
  const [messages] = onTrigger.mock.calls[0] ?? [[]]
  expect(messages).toHaveLength(3)
  expect(messages).toEqual([first, second, third])
  expect(debounce.getBufferSize()).toBe(0)
})

test('溢出觸發會立即觸發並清空 buffer', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 5 },
    onTrigger,
  )

  const message = makeMessage('12345')
  debounce.push(message)

  expect(onTrigger).toHaveBeenCalledTimes(1)
  expect(onTrigger).toHaveBeenCalledWith([message])
  expect(debounce.getBufferSize()).toBe(0)

  jest.advanceTimersByTime(200)
  expect(onTrigger).toHaveBeenCalledTimes(1)
})

test('@mention 會切換為急迫模式並在觸發後恢復', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 20, overflowChars: 3000 },
    onTrigger,
  )

  debounce.push(makeMessage('一般訊息'))
  debounce.push(makeMessage('@測試', { isMention: true }))

  jest.advanceTimersByTime(19)
  expect(onTrigger).not.toHaveBeenCalled()

  jest.advanceTimersByTime(1)
  expect(onTrigger).toHaveBeenCalledTimes(1)

  debounce.push(makeMessage('後續訊息'))
  jest.advanceTimersByTime(99)
  expect(onTrigger).toHaveBeenCalledTimes(1)

  jest.advanceTimersByTime(1)
  expect(onTrigger).toHaveBeenCalledTimes(2)
})

test('多次 push 會重設靜默計時，只觸發一次', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 3000 },
    onTrigger,
  )

  debounce.push(makeMessage('第一段'))
  jest.advanceTimersByTime(80)
  debounce.push(makeMessage('第二段'))

  jest.advanceTimersByTime(80)
  expect(onTrigger).not.toHaveBeenCalled()

  jest.advanceTimersByTime(20)
  expect(onTrigger).toHaveBeenCalledTimes(1)
})

test('flush 會立即觸發並清空 buffer', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 3000 },
    onTrigger,
  )

  const message = makeMessage('需要 flush')
  debounce.push(message)
  debounce.flush()

  expect(onTrigger).toHaveBeenCalledTimes(1)
  expect(onTrigger).toHaveBeenCalledWith([message])
  expect(debounce.getBufferSize()).toBe(0)

  jest.advanceTimersByTime(200)
  expect(onTrigger).toHaveBeenCalledTimes(1)
})

test('恰好達到 overflow 閾值 → 立即觸發', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 10 },
    onTrigger,
  )

  const message = makeMessage('1234567890') // 恰好 10 字
  debounce.push(message)

  expect(onTrigger).toHaveBeenCalledTimes(1)
  expect(onTrigger).toHaveBeenCalledWith([message])
  expect(debounce.getBufferSize()).toBe(0)
})

test('零長度 content → push 不 crash，不觸發 overflow', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 10 },
    onTrigger,
  )

  const message = makeMessage('')
  debounce.push(message)

  expect(onTrigger).not.toHaveBeenCalled()
  expect(debounce.getBufferSize()).toBe(1)
})

test('flush 空 buffer → onTrigger 不被呼叫', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 3000 },
    onTrigger,
  )

  debounce.flush()

  expect(onTrigger).not.toHaveBeenCalled()
  expect(debounce.getBufferSize()).toBe(0)
})

test('clear 取消已排程的計時器', () => {
  const onTrigger = jest.fn()
  const debounce = new Debounce(
    { silenceMs: 100, urgentMs: 50, overflowChars: 3000 },
    onTrigger,
  )

  const message = makeMessage('測試')
  debounce.push(message)
  debounce.clear()

  jest.advanceTimersByTime(200)

  expect(onTrigger).not.toHaveBeenCalled()
  expect(debounce.getBufferSize()).toBe(0)
})
