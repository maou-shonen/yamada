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
})
