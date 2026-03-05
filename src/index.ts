import type { PlatformChannel } from './types'
import process from 'node:process'
import { bootstrap } from './bootstrap'
import { loadConfig } from './config/index.ts'
import { DiscordChannel } from './discord/channel'
import { LineChannel } from './line/channel'
import { log } from './logger'

/** 可注入的選項（測試時用 mock 替換） */
export interface MainOptions {
  /** 測試時可注入 mock channel，不需要 mock.module() */
  discord?: PlatformChannel
  line?: PlatformChannel
  /** 測試時可指定 temp DB 路徑 */
  dbPath?: string
}

/**
 * 統一入口——根據環境變數自動啟用已設定的平台（Discord / LINE）。
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
    chatModel: config.CHAT_MODEL,
  }).info('Config loaded')

  const app = await bootstrap(config, { dbPath: options?.dbPath })

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
