import type { PlatformChannel } from './types'
import process from 'node:process'
import { bootstrap } from './bootstrap'
import { loadConfig } from './config/index.ts'
import { DiscordChannel } from './discord/channel'
import { LineChannel } from './line/channel'
import { log } from './logger'

/**
 * 可注入的選項（測試時用 mock 替換）
 *
 * 注意：此入口會同時啟動所有已設定的平台。
 * 若只需單一平台，請使用 src/discord/index.ts 或 src/line/index.ts。
 */
export interface MainOptions {
  /** 測試時可注入 mock channel，不需要 mock.module() */
  discord?: PlatformChannel
  line?: PlatformChannel
  /** 測試時可使用 temp dir 避免建立實際檔案 */
  dbDir?: string
}

/**
 * 雙平台入口（向後相容）
 *
 * 啟動所有已設定的平台 channels。
 * 生產環境建議改用 src/discord/index.ts 或 src/line/index.ts 分別啟動。
 */
async function main(options?: MainOptions): Promise<() => Promise<void>> {
  log.info('Loading config...')
  const config = loadConfig()

  const enabledPlatforms: string[] = []
  if (config.discordEnabled)
    enabledPlatforms.push('discord')
  if (config.lineEnabled)
    enabledPlatforms.push('line')

  log.withMetadata({
    platforms: enabledPlatforms.length > 0 ? enabledPlatforms : '(none)',
    aiProvider: config.AI_PROVIDER,
    aiModel: config.AI_MODEL,
  }).info('Config loaded')

  const app = await bootstrap(config, { dbDir: options?.dbDir })

  // 條件建立平台 channels
  const activeChannels: PlatformChannel[] = []

  if (config.discordEnabled || options?.discord) {
    const discordChannel = options?.discord ?? new DiscordChannel(config)
    activeChannels.push(discordChannel)
  }

  if (config.lineEnabled || options?.line) {
    const lineChannel = options?.line ?? new LineChannel(config)
    activeChannels.push(lineChannel)
  }

  await app.startChannels(activeChannels)

  log
    .withMetadata({
      discord: config.discordEnabled ? 'enabled' : 'disabled',
      line: config.lineEnabled ? `enabled (port ${config.LINE_WEBHOOK_PORT})` : 'disabled',
    })
    .info('yamada is running')

  // 建立 shutdown 函式供外部（測試）呼叫
  const shutdown = () => app.shutdown(activeChannels)

  // Graceful Shutdown — process.exit(0) 放在入口點層級，確保清理後硬退出
  const onShutdown = () => {
    shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        log.withError(err).error('Shutdown failed')
        process.exit(1)
      })
  }
  process.on('SIGINT', onShutdown)
  process.on('SIGTERM', onShutdown)

  return shutdown
}

// Global error handlers（不 crash bot）
process.on('uncaughtException', (err) => {
  log.withError(err).error('Uncaught Exception')
})

process.on('unhandledRejection', (reason) => {
  log
    .withError(reason instanceof Error ? reason : new Error(String(reason)))
    .error('Unhandled Rejection')
})

export { main }

// Auto-run only when executed directly (not imported in tests)
if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    log.withError(err).error(`Failed to start yamada: ${message}`)
    process.exit(1)
  })
}
