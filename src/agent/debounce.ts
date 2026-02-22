import type { UnifiedMessage } from '../types'
import { log } from '../logger'

const debounceLog = log.withPrefix('[Debounce]')

export interface DebounceConfig {
  silenceMs: number
  urgentMs: number
  overflowChars: number
}

export class Debounce {
  private buffer: UnifiedMessage[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private isUrgent = false
  private readonly config: DebounceConfig
  private readonly onTrigger: (messages: UnifiedMessage[]) => void

  constructor(
    config: DebounceConfig,
    onTrigger: (messages: UnifiedMessage[]) => void,
  ) {
    this.config = config
    this.onTrigger = onTrigger
  }

  push(message: UnifiedMessage): void {
    this.buffer.push(message)
    const totalChars = this.buffer.reduce((sum, current) => sum + current.content.length, 0)

    if (message.isMention) {
      this.isUrgent = true
      debounceLog
        .withMetadata({ groupId: message.groupId, userName: message.userName })
        .info('Mention detected, switching to urgent mode')
    }

    debounceLog
      .withMetadata({
        groupId: message.groupId,
        bufferSize: this.buffer.length,
        totalChars,
        isUrgent: this.isUrgent,
      })
      .debug('Message pushed to buffer')

    if (totalChars >= this.config.overflowChars) {
      debounceLog
        .withMetadata({
          groupId: message.groupId,
          bufferSize: this.buffer.length,
          totalChars,
          overflowThreshold: this.config.overflowChars,
        })
        .info('Overflow triggered')
      this.trigger()
      return
    }

    this.resetTimer()
  }

  flush(): void {
    if (this.buffer.length === 0) {
      this.clearTimer()
      this.isUrgent = false
      return
    }

    this.trigger()
  }

  clear(): void {
    this.buffer = []
    this.clearTimer()
    this.isUrgent = false
  }

  getBufferSize(): number {
    return this.buffer.length
  }

  private resetTimer(): void {
    this.clearTimer()

    const delayMs = this.isUrgent
      ? this.config.urgentMs
      : this.config.silenceMs

    debounceLog
      .withMetadata({ delayMs, mode: this.isUrgent ? 'urgent' : 'silence' })
      .debug('Timer reset')

    this.timer = setTimeout(() => {
      debounceLog.withMetadata({ delayMs, mode: this.isUrgent ? 'urgent' : 'silence' }).info('Silence timer expired')
      this.trigger()
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private trigger(): void {
    const messages = [...this.buffer]
    this.buffer = []
    this.clearTimer()
    const wasUrgent = this.isUrgent
    this.isUrgent = false

    debounceLog
      .withMetadata({
        messageCount: messages.length,
        wasUrgent,
        users: [...new Set(messages.map(m => m.userName))],
      })
      .info('Triggering flush')

    this.onTrigger(messages)
  }
}
