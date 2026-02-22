import { afterEach, describe, expect, it, jest } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Agent } from '../../agent/index.ts'
import { createScheduler } from '../../scheduler/index'
import {
  claimDueTriggers,
  recoverStaleTriggers,
  upsertTrigger,
} from '../../scheduler/trigger-store'
import { createTestConfig } from '../helpers/config'
import { closeMainDb, openMainDb } from '../../storage/main-db'

interface TriggerRow {
  group_id: string
  platform: string
  trigger_at: number
  pending_chars: number
  status: string
  created_at: number
  updated_at: number
}

function makeTempDir(): string {
  const dir = path.join(tmpdir(), `yamada-scheduler-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function getTrigger(sqlite: Database, groupId: string): TriggerRow | null {
  const row = sqlite.query(
    `SELECT group_id, platform, trigger_at, pending_chars, status, created_at, updated_at
     FROM pending_triggers
     WHERE group_id = ?`,
  ).get(groupId)

  return (row as TriggerRow | null) ?? null
}

function forceTriggerDue(sqlite: Database, groupId: string): void {
  const dueAt = Date.now() - 1
  sqlite.run(
    `UPDATE pending_triggers
     SET trigger_at = ?, updated_at = ?
     WHERE group_id = ?`,
    [dueAt, dueAt, groupId],
  )
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Scheduler 持久化事件佇列整合測試', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      const dbPath = path.join(dir, 'main.db')
      const walPath = `${dbPath}-wal`
      const shmPath = `${dbPath}-shm`

      if (existsSync(dbPath)) rmSync(dbPath, { force: true })
      if (existsSync(walPath)) rmSync(walPath, { force: true })
      if (existsSync(shmPath)) rmSync(shmPath, { force: true })
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
    jest.useRealTimers()
  })

  it('場景 1：Silence 觸發會在到期後被 claim 並標記 processing', () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const dbPath = path.join(tempDir, 'main.db')
    const { sqlite } = openMainDb(dbPath)

    const config = createTestConfig({
      DEBOUNCE_SILENCE_MS: 15_000,
      DEBOUNCE_URGENT_MS: 2_000,
      DEBOUNCE_OVERFLOW_CHARS: 3_000,
    })

    upsertTrigger(sqlite, 'group-silence', 'discord', false, 120, config)

    const inserted = getTrigger(sqlite, 'group-silence')
    expect(inserted).not.toBeNull()
    expect(inserted?.trigger_at).toBe((inserted?.updated_at ?? 0) + config.DEBOUNCE_SILENCE_MS)

    const claimed = claimDueTriggers(sqlite, inserted!.trigger_at)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toEqual({ groupId: 'group-silence', platform: 'discord' })
    expect(getTrigger(sqlite, 'group-silence')?.status).toBe('processing')

    closeMainDb(sqlite)
  })

  it('場景 2：Urgent 觸發（@mention）會使用 URGENT_MS 而非 SILENCE_MS', () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const dbPath = path.join(tempDir, 'main.db')
    const { sqlite } = openMainDb(dbPath)

    const config = createTestConfig({
      DEBOUNCE_SILENCE_MS: 15_000,
      DEBOUNCE_URGENT_MS: 2_000,
      DEBOUNCE_OVERFLOW_CHARS: 3_000,
    })

    upsertTrigger(sqlite, 'group-urgent', 'discord', true, 25, config)

    const row = getTrigger(sqlite, 'group-urgent')
    expect(row).not.toBeNull()
    expect(row?.trigger_at).toBe((row?.updated_at ?? 0) + config.DEBOUNCE_URGENT_MS)
    expect(row?.trigger_at).not.toBe((row?.updated_at ?? 0) + config.DEBOUNCE_SILENCE_MS)

    closeMainDb(sqlite)
  })

  it('場景 3：Overflow 觸發會立即到期並可被即時 claim', () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const dbPath = path.join(tempDir, 'main.db')
    const { sqlite } = openMainDb(dbPath)

    const config = createTestConfig({
      DEBOUNCE_SILENCE_MS: 15_000,
      DEBOUNCE_URGENT_MS: 2_000,
      DEBOUNCE_OVERFLOW_CHARS: 100,
    })

    upsertTrigger(sqlite, 'group-overflow', 'line', false, 120, config)

    const row = getTrigger(sqlite, 'group-overflow')
    expect(row).not.toBeNull()
    expect(row?.trigger_at).toBe(row?.updated_at)

    const claimed = claimDueTriggers(sqlite, Date.now())
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toEqual({ groupId: 'group-overflow', platform: 'line' })

    closeMainDb(sqlite)
  })

  it('場景 4：重啟恢復會把 processing 還原成 pending 並可再次 claim', () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const dbPath = path.join(tempDir, 'main.db')
    const { sqlite } = openMainDb(dbPath)

    const config = createTestConfig({
      DEBOUNCE_SILENCE_MS: 15_000,
      DEBOUNCE_URGENT_MS: 2_000,
      DEBOUNCE_OVERFLOW_CHARS: 3_000,
    })

    upsertTrigger(sqlite, 'group-recover', 'discord', false, 80, config)
    forceTriggerDue(sqlite, 'group-recover')

    const firstClaim = claimDueTriggers(sqlite, Date.now())
    expect(firstClaim).toEqual([{ groupId: 'group-recover', platform: 'discord' }])
    expect(getTrigger(sqlite, 'group-recover')?.status).toBe('processing')

    recoverStaleTriggers(sqlite)
    expect(getTrigger(sqlite, 'group-recover')?.status).toBe('pending')

    const secondClaim = claimDueTriggers(sqlite, Date.now())
    expect(secondClaim).toEqual([{ groupId: 'group-recover', platform: 'discord' }])

    closeMainDb(sqlite)
  })

  it('場景 5：多群組並行會維持獨立 trigger 並同時被 claim', () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const dbPath = path.join(tempDir, 'main.db')
    const { sqlite } = openMainDb(dbPath)

    const config = createTestConfig({
      DEBOUNCE_SILENCE_MS: 15_000,
      DEBOUNCE_URGENT_MS: 2_000,
      DEBOUNCE_OVERFLOW_CHARS: 3_000,
    })

    upsertTrigger(sqlite, 'group-1', 'discord', false, 10, config)
    upsertTrigger(sqlite, 'group-2', 'line', false, 20, config)
    forceTriggerDue(sqlite, 'group-1')
    forceTriggerDue(sqlite, 'group-2')

    const countRow = sqlite.query('SELECT COUNT(*) AS count FROM pending_triggers').get() as { count: number }
    expect(countRow.count).toBe(2)

    const claimed = claimDueTriggers(sqlite, Date.now())
    expect(claimed).toHaveLength(2)
    expect(claimed).toContainEqual({ groupId: 'group-1', platform: 'discord' })
    expect(claimed).toContainEqual({ groupId: 'group-2', platform: 'line' })

    closeMainDb(sqlite)
  })

  it('場景 6：Scheduler tick 端對端會呼叫 agent 並完成 trigger', async () => {
    jest.useFakeTimers()

    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const dbPath = path.join(tempDir, 'main.db')
    const { sqlite } = openMainDb(dbPath)

    const config = createTestConfig({
      SCHEDULER_POLL_INTERVAL_MS: 10,
      DEBOUNCE_SILENCE_MS: 15_000,
      DEBOUNCE_URGENT_MS: 2_000,
      DEBOUNCE_OVERFLOW_CHARS: 3_000,
    })

    upsertTrigger(sqlite, 'group-scheduler', 'discord', false, 50, config)
    forceTriggerDue(sqlite, 'group-scheduler')

    const processTriggeredMessages = jest.fn(async (_platform: 'discord' | 'line') => {})
    const fakeAgent = {
      processTriggeredMessages,
    } as unknown as Agent

    const scheduler = createScheduler({
      sqlite,
      getAgent: (groupId: string) => (groupId === 'group-scheduler' ? fakeAgent : undefined),
      config,
    })

    scheduler.start()
    jest.advanceTimersByTime(20)
    await flushAsyncWork()
    await scheduler.stop()

    expect(processTriggeredMessages).toHaveBeenCalledTimes(1)
    expect(processTriggeredMessages).toHaveBeenCalledWith('discord')
    expect(getTrigger(sqlite, 'group-scheduler')).toBeNull()

    closeMainDb(sqlite)
  })
})
