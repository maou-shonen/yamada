import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { saveFrequencyState } from '../storage/frequency-stats'
import { P_MAX, P_MIN } from './frequency-math'
import { checkFrequency } from './frequency-controller'

describe('checkFrequency', () => {
  let originalConsoleLog: typeof console.log

  beforeEach(() => {
    originalConsoleLog = console.log
  })

  afterEach(() => {
    console.log = originalConsoleLog
  })

  test('mention bypass：isMention=true 時直接通過', () => {
    const { db } = setupTestDb()
    const result = checkFrequency(db, createTestConfig(), true)

    expect(result.shouldRespond).toBeTrue()
    expect(result.probability).toBe(1)
    expect(result.metadata.reason).toBe('mention_bypass')
    expect(result.metadata.isMention).toBeTrue()
  })

  test('disabled：FREQUENCY_ENABLED=false 時直接通過', () => {
    const { db } = setupTestDb()
    const config = createTestConfig({ FREQUENCY_ENABLED: false })

    const result = checkFrequency(db, config, false)

    expect(result.shouldRespond).toBeTrue()
    expect(result.probability).toBe(1)
    expect(result.metadata.reason).toBe('disabled')
  })

  test('高 bot share 時機率降低（應該 skip）', () => {
    const { db } = setupTestDb()
    const now = 1_700_000_000_000

    saveFrequencyState(db, {
      emaLongBot: 8,
      emaLongTotal: 10,
      emaShortBot: 8,
      emaShortTotal: 10,
      lastUpdatedAt: now,
    })

    const result = checkFrequency(db, createTestConfig(), false, {
      now: () => now,
      random: () => 0.9,
      countActiveMembers: () => 4,
    })

    expect(result.metadata.target).toBeCloseTo(0.2, 4)
    expect(result.probability).toBeLessThan(0.3)
    expect(result.shouldRespond).toBeFalse()
    expect(result.metadata.reason).toBe('probability_gate')
  })

  test('低 bot share 時機率提高（應該回覆）', () => {
    const { db } = setupTestDb()
    const now = 1_700_000_000_000

    saveFrequencyState(db, {
      emaLongBot: 0,
      emaLongTotal: 10,
      emaShortBot: 0,
      emaShortTotal: 10,
      lastUpdatedAt: now,
    })

    const result = checkFrequency(db, createTestConfig(), false, {
      now: () => now,
      random: () => 0.1,
      countActiveMembers: () => 4,
    })

    expect(result.metadata.target).toBeCloseTo(0.2, 4)
    expect(result.probability).toBeGreaterThan(0.7)
    expect(result.shouldRespond).toBeTrue()
    expect(result.metadata.reason).toBe('pass')
  })

  test('冷啟動：無 frequency_state 也可計算且機率在界內', () => {
    const { db } = setupTestDb()

    const result = checkFrequency(db, createTestConfig(), false, {
      now: () => 1_700_000_000_000,
      random: () => 0.4,
      countActiveMembers: () => 4,
    })

    expect(result.probability).toBeGreaterThanOrEqual(P_MIN)
    expect(result.probability).toBeLessThanOrEqual(P_MAX)
    expect(Number.isFinite(result.probability)).toBeTrue()
  })

  test('metadata 完整性：包含所有必要欄位', () => {
    const { db } = setupTestDb()

    const result = checkFrequency(db, createTestConfig(), false, {
      now: () => 1_700_000_000_000,
      random: () => 0.2,
      countActiveMembers: () => 3,
    })

    expect(result.metadata).toEqual({
      emaLongShare: expect.any(Number),
      emaShortShare: expect.any(Number),
      target: expect.any(Number),
      activeMembers: expect.any(Number),
      rng: expect.any(Number),
      isMention: expect.any(Boolean),
      reason: expect.any(String),
    })
  })

  test('結構化 log：輸出 frequency_decision 與完整 metadata', () => {
    const { db } = setupTestDb()
    const logMock = mock(() => {})
    console.log = logMock

    checkFrequency(db, createTestConfig(), false, {
      now: () => 1_700_000_000_000,
      random: () => 0.2,
      countActiveMembers: () => 2,
    })

    expect(logMock).toHaveBeenCalledTimes(1)
    expect(logMock).toHaveBeenCalledWith(
      'frequency_decision',
      expect.objectContaining({
        shouldRespond: expect.any(Boolean),
        probability: expect.any(Number),
        emaLongShare: expect.any(Number),
        emaShortShare: expect.any(Number),
        target: expect.any(Number),
        activeMembers: expect.any(Number),
        rng: expect.any(Number),
        isMention: false,
        reason: expect.any(String),
      }),
    )
  })
})
