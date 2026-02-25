import type { Database } from 'bun:sqlite'
import type { Agent } from '../agent/index.ts'
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { createScheduler } from './index'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createTestContext() {
  const sqlite = {} as Database
  const processTriggeredMessages = jest.fn(async (_platform: 'discord' | 'line', _isMention: boolean) => {})
  const getAgent = jest.fn((_groupId: string) => ({
    processTriggeredMessages,
  }) as unknown as Agent)

  const triggerStore = {
    recoverStaleTriggers: jest.fn(() => {}),
    claimDueTriggers: jest.fn((_db: Database, _now: number) => [] as Array<{ groupId: string, platform: string, isMention: boolean }>),
    completeTrigger: jest.fn((_db: Database, _groupId: string) => {}),
  }

  const scheduler = createScheduler({
    sqlite,
    getAgent,
    config: {
      SCHEDULER_POLL_INTERVAL_MS: 10,
      DEBOUNCE_SILENCE_MS: 15000,
      DEBOUNCE_URGENT_MS: 2000,
      DEBOUNCE_OVERFLOW_CHARS: 3000,
    },
    triggerStore,
  })

  return {
    scheduler,
    sqlite,
    getAgent,
    processTriggeredMessages,
    triggerStore,
  }
}

describe('scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(async () => {
    jest.runOnlyPendingTimers()
    await flushAsyncWork()
    jest.useRealTimers()
  })

  it('createScheduler 會回傳包含 start 與 stop 的物件', () => {
    const { scheduler } = createTestContext()

    expect(scheduler).toEqual({
      start: expect.any(Function),
      stop: expect.any(Function),
    })
  })

  it('start 後會依輪詢間隔觸發 tick', async () => {
    const { scheduler, triggerStore } = createTestContext()

    scheduler.start()
    jest.advanceTimersByTime(30)
    await flushAsyncWork()

    expect(triggerStore.claimDueTriggers).toHaveBeenCalledTimes(3)
  })

  it('tick 首次會 recoverStaleTriggers，後續不重複 recover', async () => {
    const { scheduler, triggerStore } = createTestContext()

    scheduler.start()
    jest.advanceTimersByTime(20)
    await flushAsyncWork()

    expect(triggerStore.recoverStaleTriggers).toHaveBeenCalledTimes(1)
    expect(triggerStore.claimDueTriggers).toHaveBeenCalledTimes(2)
  })

  it('tick 會呼叫 claimDueTriggers(sqlite, now)', async () => {
    const { scheduler, triggerStore, sqlite } = createTestContext()

    scheduler.start()
    jest.advanceTimersByTime(10)
    await flushAsyncWork()

    expect(triggerStore.claimDueTriggers).toHaveBeenCalledTimes(1)
    expect(triggerStore.claimDueTriggers).toHaveBeenCalledWith(sqlite, expect.any(Number))
  })

  it('claimed trigger 會呼叫 agent.processTriggeredMessages(platform, isMention)', async () => {
    const { scheduler, triggerStore, processTriggeredMessages } = createTestContext()
    triggerStore.claimDueTriggers.mockReturnValueOnce([{ groupId: 'group-1', platform: 'discord', isMention: true }])

    scheduler.start()
    jest.advanceTimersByTime(10)
    await flushAsyncWork()

    expect(processTriggeredMessages).toHaveBeenCalledTimes(1)
    expect(processTriggeredMessages).toHaveBeenCalledWith('discord', true)
  })

  it('claimed trigger 非 mention 時應傳遞 isMention=false', async () => {
    const { scheduler, triggerStore, processTriggeredMessages } = createTestContext()
    triggerStore.claimDueTriggers.mockReturnValueOnce([{ groupId: 'group-2', platform: 'line', isMention: false }])

    scheduler.start()
    jest.advanceTimersByTime(10)
    await flushAsyncWork()

    expect(processTriggeredMessages).toHaveBeenCalledTimes(1)
    expect(processTriggeredMessages).toHaveBeenCalledWith('line', false)
  })

  it('processTriggeredMessages 成功或失敗都會 completeTrigger', async () => {
    const { scheduler, triggerStore, processTriggeredMessages, sqlite } = createTestContext()
    triggerStore.claimDueTriggers.mockReturnValueOnce([
      { groupId: 'group-ok', platform: 'discord', isMention: false },
      { groupId: 'group-fail', platform: 'line', isMention: true },
    ])

    processTriggeredMessages
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('pipeline failed'))

    scheduler.start()
    jest.advanceTimersByTime(10)
    await flushAsyncWork()

    expect(triggerStore.completeTrigger).toHaveBeenCalledTimes(2)
    expect(triggerStore.completeTrigger).toHaveBeenNthCalledWith(1, sqlite, 'group-ok')
    expect(triggerStore.completeTrigger).toHaveBeenNthCalledWith(2, sqlite, 'group-fail')
  })

  it('tick 發生例外時會被捕捉且排程器持續運作', async () => {
    const { scheduler, triggerStore } = createTestContext()
    triggerStore.claimDueTriggers
      .mockImplementationOnce(() => {
        throw new Error('claim failed')
      })
      .mockReturnValueOnce([])

    scheduler.start()
    jest.advanceTimersByTime(20)
    await flushAsyncWork()

    expect(triggerStore.claimDueTriggers).toHaveBeenCalledTimes(2)
  })

  it('stop 後不再觸發後續 tick', async () => {
    const { scheduler, triggerStore } = createTestContext()

    scheduler.start()
    jest.advanceTimersByTime(10)
    await flushAsyncWork()
    await scheduler.stop()

    jest.advanceTimersByTime(50)
    await flushAsyncWork()

    expect(triggerStore.claimDueTriggers).toHaveBeenCalledTimes(1)
  })

  it('stop 會等待 in-flight tick 完成', async () => {
    const { scheduler, triggerStore, processTriggeredMessages } = createTestContext()
    const deferred = createDeferred<void>()

    triggerStore.claimDueTriggers.mockReturnValueOnce([{ groupId: 'group-1', platform: 'discord', isMention: false }])
    processTriggeredMessages.mockImplementationOnce(() => deferred.promise)

    scheduler.start()
    jest.advanceTimersByTime(10)
    await flushAsyncWork()

    let stopped = false
    const stopPromise = scheduler.stop().then(() => {
      stopped = true
    })

    await flushAsyncWork()
    expect(stopped).toBe(false)

    deferred.resolve(undefined)
    await stopPromise

    expect(stopped).toBe(true)
  })
})
