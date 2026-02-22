import process from 'node:process'
import { bootstrap } from '../bootstrap'
import { loadConfig } from '../config/index.ts'
import { log } from '../logger'
import { LineChannel } from './channel'

/**
 * LINE 專用入口點
 *
 * 啟動序列：config → 共用 bootstrap → LineChannel (Bun.serve webhook) → start
 * 僅啟動 LINE Webhook server，不連接 Discord Gateway。
 */
async function main(): Promise<void> {
  log.info('Loading config (LINE mode)...')
  const config = loadConfig()

  if (!config.lineEnabled) {
    throw new Error('LINE 未啟用：請設定 LINE_CHANNEL_SECRET 和 LINE_CHANNEL_ACCESS_TOKEN')
  }

  const app = await bootstrap(config)

  const lineChannel = new LineChannel(config)
  await app.startChannels([lineChannel])

  log
    .withMetadata({ port: config.LINE_WEBHOOK_PORT, aiModel: config.AI_MODEL })
    .info('yamada is running (LINE mode)')

  // Graceful Shutdown — process.exit(0) 放在入口點層級
  const onShutdown = () => {
    app.shutdown([lineChannel])
      .then(() => process.exit(0))
      .catch((err) => {
        log.withError(err).error('Shutdown failed')
        process.exit(1)
      })
  }
  process.on('SIGINT', onShutdown)
  process.on('SIGTERM', onShutdown)
}

// Global error handlers
process.on('uncaughtException', (err) => {
  log.withError(err).error('Uncaught Exception')
})

process.on('unhandledRejection', (reason) => {
  log
    .withError(reason instanceof Error ? reason : new Error(String(reason)))
    .error('Unhandled Rejection')
})

export { main }

if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    log.withError(err).error(`Failed to start yamada (LINE): ${message}`)
    process.exit(1)
  })
}
