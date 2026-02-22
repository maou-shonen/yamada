import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { closeMainDb, openMainDb } from './main-db'

const TEST_DB_PATH = join(tmpdir(), `test-main-db-${Date.now()}.db`)

afterEach(() => {
  try {
    rmSync(TEST_DB_PATH, { force: true })
  }
  catch {}
})

describe('openMainDb', () => {
  it('應回傳 { db, sqlite } 物件（非 null）', () => {
    const result = openMainDb(TEST_DB_PATH)
    expect(result).toBeDefined()
    expect(result.db).toBeDefined()
    expect(result.sqlite).toBeDefined()
    closeMainDb(result.sqlite)
  })

  it('應自動建立 pending_triggers table', () => {
    const { sqlite } = openMainDb(TEST_DB_PATH)
    const tables = sqlite.query(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='pending_triggers'
    `).all()
    expect(tables).toHaveLength(1)
    closeMainDb(sqlite)
  })

  it('應啟用 WAL mode', () => {
    const { sqlite } = openMainDb(TEST_DB_PATH)
    const result = sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(result.journal_mode).toBe('wal')
    closeMainDb(sqlite)
  })

  it('應設定 busy_timeout 為 10000', () => {
    const { sqlite } = openMainDb(TEST_DB_PATH)
    const result = sqlite.query('PRAGMA busy_timeout').get() as { timeout: number }
    expect(result.timeout).toBe(10000)
    closeMainDb(sqlite)
  })

  it('應具有冪等性：呼叫兩次不報錯', () => {
    const { sqlite: sqlite1 } = openMainDb(TEST_DB_PATH)
    closeMainDb(sqlite1)

    const { sqlite: sqlite2 } = openMainDb(TEST_DB_PATH)
    expect(sqlite2).toBeDefined()
    closeMainDb(sqlite2)
  })

  it('pending_triggers table 應有正確的欄位和索引', () => {
    const { sqlite } = openMainDb(TEST_DB_PATH)

    // 檢查欄位
    const columns = sqlite.query(`PRAGMA table_info(pending_triggers)`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    const columnNames = columns.map(c => c.name)
    expect(columnNames).toContain('group_id')
    expect(columnNames).toContain('platform')
    expect(columnNames).toContain('trigger_at')
    expect(columnNames).toContain('pending_chars')
    expect(columnNames).toContain('status')
    expect(columnNames).toContain('created_at')
    expect(columnNames).toContain('updated_at')

    // 檢查索引
    const indexes = sqlite.query(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND tbl_name='pending_triggers'
    `).all() as Array<{ name: string }>

    const indexNames = indexes.map(i => i.name)
    expect(indexNames).toContain('idx_triggers_status_trigger')

    closeMainDb(sqlite)
  })
})

describe('closeMainDb', () => {
  it('應成功關閉連線', () => {
    const { sqlite } = openMainDb(TEST_DB_PATH)
    expect(() => closeMainDb(sqlite)).not.toThrow()
  })

  it('關閉後 query 應拋出錯誤', () => {
    const { sqlite } = openMainDb(TEST_DB_PATH)
    closeMainDb(sqlite)

    expect(() => {
      sqlite.query('SELECT 1').get()
    }).toThrow()
  })
})
