import process from 'node:process'
import { bootstrap } from '../bootstrap'
import { loadConfig } from '../config/index.ts'
import { log } from '../logger'
import { DiscordChannel } from './channel'

/**
 * Discord 專用入口點
 *
 * 啟動序列：config → 共用 bootstrap → DiscordChannel → start
 * 僅啟動 Discord Gateway，不啟動 LINE Webhook server。
 */
async function main(): Promise<void> {
  log.info('Loading config (Discord mode)...')
  const config = loadConfig()

  if (!config.discordEnabled) {
    throw new Error('Discord 未啟用：請設定 DISCORD_TOKEN 和 DISCORD_CLIENT_ID')
  }

  const app = await bootstrap(config)

  const discordChannel = new DiscordChannel(config)
  await app.startChannels([discordChannel])

  log
    .withMetadata({ aiModel: config.AI_MODEL })
    .info('yamada is running (Discord mode)')

  // Graceful Shutdown — process.exit(0) 放在入口點層級
  const onShutdown = () => {
    app.shutdown([discordChannel])
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
    log.withError(err).error(`Failed to start yamada (Discord): ${message}`)
    process.exit(1)
  })
}
