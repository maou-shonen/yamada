import { describe, expect, test } from 'bun:test'
import { loadConfig } from './index'

describe('loadConfig', () => {
  describe('SCHEDULER_POLL_INTERVAL_MS', () => {
    test('預設值為 2000', () => {
      const config = loadConfig({
        DISCORD_TOKEN: 'test-token',
        DISCORD_CLIENT_ID: 'test-id',
      })
      expect(config.SCHEDULER_POLL_INTERVAL_MS).toBe(2000)
    })

    test('可透過環境變數覆蓋', () => {
      const config = loadConfig({
        DISCORD_TOKEN: 'test-token',
        DISCORD_CLIENT_ID: 'test-id',
        SCHEDULER_POLL_INTERVAL_MS: '500',
      })
      expect(config.SCHEDULER_POLL_INTERVAL_MS).toBe(500)
    })

    test('必須是正整數', () => {
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: 'test-token',
          DISCORD_CLIENT_ID: 'test-id',
          SCHEDULER_POLL_INTERVAL_MS: '0',
        }),
      ).toThrow()

      expect(() =>
        loadConfig({
          DISCORD_TOKEN: 'test-token',
          DISCORD_CLIENT_ID: 'test-id',
          SCHEDULER_POLL_INTERVAL_MS: '-1',
        }),
      ).toThrow()
    })

    test('接受字串並強制轉換為數字', () => {
      const config = loadConfig({
        DISCORD_TOKEN: 'test-token',
        DISCORD_CLIENT_ID: 'test-id',
        SCHEDULER_POLL_INTERVAL_MS: '3000',
      })
      expect(config.SCHEDULER_POLL_INTERVAL_MS).toBe(3000)
      expect(typeof config.SCHEDULER_POLL_INTERVAL_MS).toBe('number')
    })
  })

  describe('FREQUENCY_*', () => {
    test('預設值正確', () => {
      const config = loadConfig({})
      expect(config.FREQUENCY_ENABLED).toBe(true)
      expect(config.FREQUENCY_LONG_HALFLIFE_HOURS).toBe(120)
      expect(config.FREQUENCY_SHORT_HALFLIFE_HOURS).toBe(4)
      expect(config.FREQUENCY_ACTIVE_WINDOW_DAYS).toBe(7)
    })

    test('可透過環境變數覆寫', () => {
      const config = loadConfig({
        FREQUENCY_LONG_HALFLIFE_HOURS: '48',
        FREQUENCY_ENABLED: 'false',
      })
      expect(config.FREQUENCY_ENABLED).toBe(false)
      expect(config.FREQUENCY_LONG_HALFLIFE_HOURS).toBe(48)
      expect(config.FREQUENCY_SHORT_HALFLIFE_HOURS).toBe(4)
      expect(config.FREQUENCY_ACTIVE_WINDOW_DAYS).toBe(7)
    })

    test('FREQUENCY_ENABLED 支援 "1" 為 true', () => {
      const config = loadConfig({ FREQUENCY_ENABLED: '1' })
      expect(config.FREQUENCY_ENABLED).toBe(true)
    })
  })
})
