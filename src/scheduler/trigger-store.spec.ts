import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { closeMainDb, openMainDb } from '../storage/main-db'
import { claimDueTriggers, completeTrigger, recoverStaleTriggers, upsertTrigger } from './trigger-store'

const testConfig = {
  DEBOUNCE_SILENCE_MS: 15000,
  DEBOUNCE_URGENT_MS: 2000,
  DEBOUNCE_OVERFLOW_CHARS: 3000,
}

interface TriggerRow {
  group_id: string
  platform: string
  trigger_at: number
  pending_chars: number
  status: string
  created_at: number
  updated_at: number
}

function getTrigger(sqlite: Database, groupId: string): TriggerRow | null {
  const row = sqlite.query(
    `SELECT group_id, platform, trigger_at, pending_chars, status, created_at, updated_at
     FROM pending_triggers WHERE group_id = ?`,
  ).get(groupId)

  return (row as TriggerRow | null) ?? null
}

describe('trigger-store', () => {
  let dbPath = ''
  let sqlite: Database

  beforeEach(() => {
    dbPath = join(tmpdir(), `trigger-store-${Date.now()}-${crypto.randomUUID()}.db`)
    const { sqlite: mainSqlite } = openMainDb(dbPath)
    sqlite = mainSqlite
  })

  afterEach(() => {
    closeMainDb(sqlite)
    rmSync(dbPath, { force: true })
  })

  it('upsertTrigger 新記錄時應使用 silence 延遲', () => {
    upsertTrigger(sqlite, 'group-1', 'discord', false, 120, testConfig)

    const row = getTrigger(sqlite, 'group-1')
    expect(row).not.toBeNull()
    expect(row?.platform).toBe('discord')
    expect(row?.pending_chars).toBe(120)
    expect(row?.status).toBe('pending')
    expect(row?.trigger_at).toBe((row?.updated_at ?? 0) + testConfig.DEBOUNCE_SILENCE_MS)
    expect(row?.created_at).toBe(row?.updated_at)
  })

  it('upsertTrigger 已存在時應重置 trigger_at 並累加 pending_chars', () => {
    upsertTrigger(sqlite, 'group-1', 'discord', false, 100, testConfig)
    const first = getTrigger(sqlite, 'group-1')

    upsertTrigger(sqlite, 'group-1', 'discord', false, 250, testConfig)
    const second = getTrigger(sqlite, 'group-1')

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second?.pending_chars).toBe(350)
    expect(second?.trigger_at).toBe((second?.updated_at ?? 0) + testConfig.DEBOUNCE_SILENCE_MS)
    expect(second?.created_at).toBe(first?.created_at)
  })

  it('upsertTrigger isMention=true 時應使用 urgent 延遲', () => {
    upsertTrigger(sqlite, 'group-urgent', 'discord', true, 10, testConfig)

    const row = getTrigger(sqlite, 'group-urgent')
    expect(row).not.toBeNull()
    expect(row?.trigger_at).toBe((row?.updated_at ?? 0) + testConfig.DEBOUNCE_URGENT_MS)
  })

  it('upsertTrigger 累積超過 overflow 門檻時應立即觸發', () => {
    upsertTrigger(sqlite, 'group-overflow', 'discord', false, 2900, testConfig)
    upsertTrigger(sqlite, 'group-overflow', 'discord', false, 200, testConfig)

    const row = getTrigger(sqlite, 'group-overflow')
    expect(row).not.toBeNull()
    expect(row?.pending_chars).toBe(3100)
    expect(row?.trigger_at).toBe(row?.updated_at)
  })

  it('claimDueTriggers 應 claim 到期 triggers 並更新為 processing', () => {
    const now = Date.now()
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['group-due-1', 'discord', now - 10, 100, 'pending', now - 10, now - 10],
    )
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['group-due-2', 'line', now, 200, 'pending', now - 10, now - 10],
    )
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['group-future', 'discord', now + 60_000, 300, 'pending', now - 10, now - 10],
    )

    const claimed = claimDueTriggers(sqlite, now)

    expect(claimed).toHaveLength(2)
    expect(claimed).toContainEqual({ groupId: 'group-due-1', platform: 'discord' })
    expect(claimed).toContainEqual({ groupId: 'group-due-2', platform: 'line' })
    expect(getTrigger(sqlite, 'group-due-1')?.status).toBe('processing')
    expect(getTrigger(sqlite, 'group-due-2')?.status).toBe('processing')
    expect(getTrigger(sqlite, 'group-future')?.status).toBe('pending')
  })

  it('claimDueTriggers 應具備 atomic 行為，重複 claim 不應拿到同一筆', () => {
    const now = Date.now()
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['group-atomic', 'discord', now - 1, 10, 'pending', now - 1, now - 1],
    )

    const firstClaim = claimDueTriggers(sqlite, now)
    const secondClaim = claimDueTriggers(sqlite, now)

    expect(firstClaim).toHaveLength(1)
    expect(firstClaim[0]).toEqual({ groupId: 'group-atomic', platform: 'discord' })
    expect(secondClaim).toHaveLength(0)
  })

  it('completeTrigger 應刪除指定群組 trigger', () => {
    upsertTrigger(sqlite, 'group-complete', 'discord', false, 100, testConfig)
    expect(getTrigger(sqlite, 'group-complete')).not.toBeNull()

    completeTrigger(sqlite, 'group-complete')

    expect(getTrigger(sqlite, 'group-complete')).toBeNull()
  })

  it('recoverStaleTriggers 應將 processing 恢復為 pending', () => {
    const now = Date.now()
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['group-stale', 'discord', now - 100, 80, 'processing', now - 100, now - 100],
    )
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['group-pending', 'line', now - 100, 90, 'pending', now - 100, now - 100],
    )

    recoverStaleTriggers(sqlite)

    expect(getTrigger(sqlite, 'group-stale')?.status).toBe('pending')
    expect(getTrigger(sqlite, 'group-pending')?.status).toBe('pending')
  })
})
