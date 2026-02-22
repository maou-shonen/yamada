import type { Config } from '../config/index.ts'
import type { PlatformChannel } from '../types'
import { log } from '../logger'
import { truncateText } from '../utils/text'

const deliveryLog = log.withPrefix('[Delivery]')

export interface DeliverReplyParams {
  channel: PlatformChannel
  groupId: string
  content: string
  platform: 'discord' | 'line'
  config: Config
}

export interface DeliverReactionParams {
  channel: PlatformChannel
  groupId: string
  messageId: string
  emoji: string
}

/**
 * 投遞回覆訊息至平台。
 * 根據平台限制截斷內容，sendMessage 失敗時 log error 但不 throw。
 * 原因：bot 穩定性優先於單則訊息投遞成功——失敗的回覆不應 crash pipeline 或阻擋後續群組處理。
 */
export async function deliverReply(params: DeliverReplyParams): Promise<void> {
  const { channel, groupId, content, platform, config } = params
  const limit = platform === 'discord'
    ? config.DELIVERY_DISCORD_MAX_LENGTH
    : config.DELIVERY_LINE_MAX_LENGTH
  const truncated = truncateText(content, limit)
  const wasTruncated = truncated.length < content.length

  deliveryLog
    .withMetadata({
      groupId,
      platform,
      originalLength: content.length,
      truncatedLength: truncated.length,
      wasTruncated,
      contentPreview: truncated.slice(0, 80),
    })
    .info('Delivering reply')

  try {
    await channel.sendMessage(groupId, truncated)
    deliveryLog.withMetadata({ groupId, platform }).info('Reply sent successfully')
  }
  catch (error) {
    deliveryLog
      .withError(error)
      .withMetadata({ groupId })
      .error('sendMessage failed')
    // 不 throw — 回覆失敗不應 crash bot
  }
}

/**
 * 投遞反應至平台。
 * sendReaction 失敗時 log warning 但不 throw。
 * 原因：反應是裝飾性功能，非關鍵路徑——失敗不應影響 bot 穩定性。
 */
export async function deliverReaction(
  params: DeliverReactionParams,
): Promise<void> {
  const { channel, groupId, messageId, emoji } = params

  try {
    await channel.sendReaction(groupId, messageId, emoji)
  }
  catch (error) {
    deliveryLog
      .withError(error)
      .withMetadata({ groupId, emoji })
      .warn('sendReaction failed')
    // 不 throw
  }
}
