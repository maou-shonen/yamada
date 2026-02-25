import type { Message, TextChannel } from 'discord.js'
import type { Config } from '../config/index.ts'
import type { PlatformChannel, UnifiedMessage } from '../types.ts'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,

} from 'discord.js'
import { log } from '../logger.ts'
import { truncateText, STICKER_CONTENT } from '../utils/text.ts'

const discordLog = log.withPrefix('[Discord]')

/**
 * Discord Gateway 插件
 *
 * guild mode 與 channel mode 的設計差異：
 * - guild mode：同一 server 的所有 text channel 共用一個 groupId（server id）。
 *   因為 Discord server 本質上是一個群組，多個 channel 只是話題分區。
 *   我們追蹤最近活躍的 channel，用於回覆時的投遞目標。
 * - channel mode：每個 text channel 獨立 groupId（channel id）。
 *   適合 server 中每個 channel 都是獨立話題的場景。
 */
export class DiscordChannel implements PlatformChannel {
  readonly name = 'discord'

  onMessage: (message: UnifiedMessage) => void = () => {}

  private readonly client: Client
  private readonly config: Config

  /**
   * guild mode 下追蹤每個 guild 最近活躍的 channel。
   * key = guild id, value = 最近一次收到訊息的 TextChannel。
   */
  private readonly activeChannels = new Map<string, TextChannel>()

  constructor(config: Config) {
    if (!config.discordEnabled) {
      throw new Error('DiscordChannel 需要 Discord 設定（DISCORD_TOKEN + DISCORD_CLIENT_ID），但未啟用')
    }
    this.config = config
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })
  }

  /**
   * 連接 Discord Gateway。
   *
   * WHY 包裝在 ClientReady promise 中：
   * client.login() 會立即 resolve，但此時 client 尚未完全初始化。
   * 我們需要等待 ClientReady 事件，確保 client.user 已設定，
   * 才能在後續的 isMention 檢查中正確比對 bot 的 userId。
   */
  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, message =>
      this.handleMessageCreate(message))

    await new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, () => {
        discordLog
          .withMetadata({ botUser: this.client.user?.tag })
          .info('Connected to Discord Gateway')
        resolve()
      })
      this.client.login(this.config.DISCORD_TOKEN)
    })
  }

  /** 斷開 Discord Gateway 連線 */
  async stop(): Promise<void> {
    this.client.destroy()
  }

  /**
   * 發送訊息到指定 group。
   *
   * WHY guild mode 從 activeChannels 解析 channel：
   * Discord API 需要一個具體的 TextChannel 才能發送訊息，
   * 但 guild mode 的 groupId 是 guild id（不是 channel id）。
   * 我們追蹤最近活躍的 channel 作為啟發式方法，
   * 假設最後一次有人說話的 channel 就是對話應該繼續的地方。
   *
   * Constraint：content 超過 2000 字元會被截斷（Discord 限制）。
   */
  async sendMessage(groupId: string, content: string): Promise<void> {
    const truncated = truncateText(content, this.config.DELIVERY_DISCORD_MAX_LENGTH)
    const channel = await this.resolveChannel(groupId)
    if (!channel)
      return

    await channel.send(truncated)
  }

  async sendReaction(
    groupId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channel = await this.resolveChannel(groupId)
    if (!channel)
      return

    const message = await channel.messages.fetch(messageId)
    await message.react(emoji)
  }

  private async resolveChannel(groupId: string): Promise<TextChannel | undefined> {
    if (this.config.DISCORD_GROUP_ID_MODE === 'guild') {
      return this.activeChannels.get(groupId)
    }

    const fetched = await this.client.channels.fetch(groupId)
    if (!fetched || fetched.type !== ChannelType.GuildText) {
      discordLog.withMetadata({ groupId, type: fetched?.type }).warn('Channel not found or not a text channel')
      return undefined
    }
    return fetched as TextChannel
  }

  private handleMessageCreate(message: Message): void {
    if (message.author.bot)
      return

    if (!message.guild)
      return

    discordLog
      .withMetadata({
        guildId: message.guild.id,
        channelId: message.channel.id,
        authorId: message.author.id,
        authorName: message.author.displayName,
        contentLength: message.content.length,
      })
      .debug('MessageCreate event')

    const groupId
      = this.config.DISCORD_GROUP_ID_MODE === 'guild'
        ? message.guild.id
        : message.channel.id

    if (this.config.DISCORD_GROUP_ID_MODE === 'guild') {
      this.activeChannels.set(
        message.guild.id,
        message.channel as TextChannel,
      )
    }

    // 處理 content：空 content 時嘗試從 attachment / sticker 推導
    let content = message.content
    if (!content) {
      if (message.attachments.size > 0) {
        content = '[圖片]'
      }
      else if (message.stickers.size > 0) {
        content = STICKER_CONTENT
      }
      else {
        // 無 content、無 attachment、無 sticker → 跳過
        return
      }
    }

    // WHY 將 @everyone 視為 mention：
    // 若有人 @everyone，bot 應該立即回應（進入急迫模式），
    // 而不是等待靜默觸發。
    const isMention
      = message.mentions.everyone
        || (this.client.user !== null
          && message.mentions.users.has(this.client.user.id))

    const unified: UnifiedMessage = {
      id: message.id,
      groupId,
      userId: message.author.id,
      userName: message.author.displayName,
      content,
      timestamp: message.createdAt,
      platform: 'discord',
      isBot: false,
      isMention,
      replyToExternalId: message.reference?.messageId,
      raw: message,
    }

    this.onMessage(unified)
  }
}
