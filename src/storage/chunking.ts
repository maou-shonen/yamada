import type { StoredMessage } from '../types'
import { isEmbeddableContent } from '../utils/text'

export interface ChunkInput {
  content: string
  messageIds: number[]
  startTimestamp: number
  endTimestamp: number
}

export interface ChunkingDeps {
  estimateTokens: (text: string, ratio: number) => number
}

const defaultChunkingDeps: ChunkingDeps = {
  estimateTokens: (text, ratio) => Math.ceil(text.length / ratio),
}

interface GroupMessage {
  id: number
  line: string | null
}

interface MessageGroup {
  messageIds: number[]
  messages: GroupMessage[]
  startTs: number
  endTs: number
}

export function buildChunks(
  messages: StoredMessage[],
  tokenLimit: number,
  ratio: number = 3,
  deps: ChunkingDeps = defaultChunkingDeps,
): ChunkInput[] {
  if (messages.length === 0) {
    return []
  }

  const externalIdToInternalId = new Map<string, number>()
  for (const message of messages) {
    if (message.externalId !== null) {
      externalIdToInternalId.set(message.externalId, message.id)
    }
  }

  const groupOf = new Map<number, number>()
  const groups = new Map<number, MessageGroup>()
  let currentStandaloneGroupId: number | null = null

  for (const message of messages) {
    const line = isEmbeddableContent(message.content) ? `${message.userId}: ${message.content}` : null
    let targetGroupId: number | null = null

    if (message.replyToExternalId !== null) {
      const parentId = externalIdToInternalId.get(message.replyToExternalId) ?? null
      if (parentId !== null) {
        targetGroupId = groupOf.get(parentId) ?? null
      }
    }

    if (targetGroupId !== null) {
      const group = groups.get(targetGroupId)
      if (!group) {
        continue
      }

      group.messageIds.push(message.id)
      group.messages.push({ id: message.id, line })
      group.endTs = message.timestamp
      groupOf.set(message.id, targetGroupId)
      currentStandaloneGroupId = null
      continue
    }

    if (message.replyToExternalId === null) {
      if (currentStandaloneGroupId === null) {
        currentStandaloneGroupId = message.id
        groups.set(message.id, {
          messageIds: [message.id],
          messages: [{ id: message.id, line }],
          startTs: message.timestamp,
          endTs: message.timestamp,
        })
        groupOf.set(message.id, message.id)
      }
      else {
        const group = groups.get(currentStandaloneGroupId)
        if (!group) {
          continue
        }

        group.messageIds.push(message.id)
        group.messages.push({ id: message.id, line })
        group.endTs = message.timestamp
        groupOf.set(message.id, currentStandaloneGroupId)
      }
      continue
    }

    currentStandaloneGroupId = null
    groups.set(message.id, {
      messageIds: [message.id],
      messages: [{ id: message.id, line }],
      startTs: message.timestamp,
      endTs: message.timestamp,
    })
    groupOf.set(message.id, message.id)
  }

  const result: ChunkInput[] = []
  for (const group of groups.values()) {
    splitGroupIntoChunks(group, tokenLimit, ratio, deps, result)
  }

  return result
}

function splitGroupIntoChunks(
  group: MessageGroup,
  tokenLimit: number,
  ratio: number,
  deps: ChunkingDeps,
  result: ChunkInput[],
): void {
  if (group.messages.every(message => message.line === null)) {
    return
  }

  let currentLines: string[] = []
  let currentTokens = 0

  for (const message of group.messages) {
    if (message.line === null) {
      continue
    }

    const lineTokens = deps.estimateTokens(message.line, ratio)
    if (currentLines.length > 0 && currentTokens + lineTokens > tokenLimit) {
      result.push({
        content: currentLines.join('\n'),
        messageIds: [...group.messageIds],
        startTimestamp: group.startTs,
        endTimestamp: group.endTs,
      })
      currentLines = []
      currentTokens = 0
    }

    currentLines.push(message.line)
    currentTokens += lineTokens
  }

  if (currentLines.length > 0) {
    result.push({
      content: currentLines.join('\n'),
      messageIds: [...group.messageIds],
      startTimestamp: group.startTs,
      endTimestamp: group.endTs,
    })
  }
}
