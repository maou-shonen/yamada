import type { ModelMessage } from 'ai'
import type { Database } from 'bun:sqlite'
import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { StoredMessage } from '../types'
import { log } from '../logger'
import { getChunkContents } from '../storage/chunks'
import { embedText, searchSimilarChunks } from '../storage/embedding'
import { getGroupSummary, getUserSummariesForGroup } from '../storage/summaries'

const contextLog = log.withPrefix('[Context]')

export interface ContextDeps {
  getUserSummariesForGroup: typeof getUserSummariesForGroup
  getGroupSummary: typeof getGroupSummary
  embedText: typeof embedText
  searchSimilarChunks: typeof searchSimilarChunks
  getChunkContents: typeof getChunkContents
}

const defaultDeps: ContextDeps = {
  getUserSummariesForGroup,
  getGroupSummary,
  embedText,
  searchSimilarChunks,
  getChunkContents,
}

export interface AssembleContextParams {
  recentMessages: StoredMessage[]
  config: Config
  db: DB
  sqliteDb: Database
  deps?: ContextDeps
}

/**
 * 組裝 AI 對話 context。
 *
 * System prompt 各區塊以 XML 標籤分隔，避免 LLM 混淆區塊邊界。
 * 優先序：SOUL > 群組摘要 > 用戶資料 > 相關歷史。
 * 近期訊息轉為 user/assistant 交替的 chat messages——
 * 連續的非 bot 訊息合併為單一 user message，維持正確的對話輪次結構。
 */
export async function assembleContext(params: AssembleContextParams): Promise<ModelMessage[]> {
  const { recentMessages, config, db, sqliteDb } = params
  const deps = params.deps ?? defaultDeps

  contextLog.withMetadata({ recentMessageCount: recentMessages.length }).info('Assembling context')

  const ratio = config.CONTEXT_TOKEN_ESTIMATE_RATIO

  // ── 各區塊收集 ──

  const soulSection = `<soul>\n${config.SOUL}\n</soul>`

  let groupSummarySection = ''
  const groupSummary = await deps.getGroupSummary(db)
  if (groupSummary) {
    groupSummarySection = `<group_summary>\n${groupSummary}\n</group_summary>`
    contextLog.withMetadata({ groupSummaryLength: groupSummary.length }).debug('Group summary loaded')
  }
  else {
    contextLog.debug('No group summary found')
  }

  // 只取非 bot 用戶——bot 訊息是生成的，不代表個人特徵
  const nonBotUserIds = [...new Set(
    recentMessages.filter(m => !m.isBot).map(m => m.userId),
  )]
  const userSummaryMap = await deps.getUserSummariesForGroup(db, nonBotUserIds)
  let userSummarySection = ''
  if (userSummaryMap.size > 0) {
    const lines = [...userSummaryMap.entries()].map(([uid, summary]) => `${uid}: ${summary}`)
    userSummarySection = `<user_profiles>\n${lines.join('\n')}\n</user_profiles>`
    contextLog.withMetadata({ userCount: userSummaryMap.size }).debug('User summaries loaded')
  }

  // 語義搜尋：僅在 embedding 啟用時執行，取最後一則非 bot 訊息作為查詢向量
  let semanticSection = ''
  if (config.embeddingEnabled) {
    const lastNonBot = [...recentMessages].reverse().find(m => !m.isBot)
    if (lastNonBot) {
      try {
        contextLog.withMetadata({ query: lastNonBot.content.slice(0, 60) }).debug('Running semantic search')
        const embedding = await deps.embedText(lastNonBot.content, config)
        const similar = deps.searchSimilarChunks(
          sqliteDb,
          embedding,
          config.CONTEXT_SEMANTIC_TOP_K,
          config.CONTEXT_SEMANTIC_THRESHOLD,
        )
        contextLog.withMetadata({ resultsCount: similar.length }).debug('Semantic search results')
        if (similar.length > 0) {
          const chunkIds = similar.map(s => s.chunkId)
          const contents = deps.getChunkContents(db, chunkIds)
          if (contents.length > 0) {
            semanticSection = `<related_history>\n${contents.join('\n')}\n</related_history>`
          }
        }
      }
      catch (err) {
        // 語義搜尋失敗不中斷流程，降級繼續
        contextLog.withError(err instanceof Error ? err : new Error(String(err))).warn('Semantic search failed, skipping')
      }
    }
  }

  // ── Token 預算裁剪 ──
  // 裁剪順序：semantic → userSummary。
  // 語義搜尋是「錦上添花」的歷史回顧，user summary 對人格一致性更關鍵，
  // 而 SOUL 和 group summary 是不可裁剪的核心。
  const maxTokens = config.CONTEXT_MAX_TOKENS
  const estimateTokens = (parts: string[]) => Math.ceil(parts.filter(Boolean).join('').length / ratio)
  let trimmedSemantic = false
  let trimmedUserSummaries = false

  if (estimateTokens([soulSection, groupSummarySection, userSummarySection, semanticSection]) > maxTokens && semanticSection) {
    semanticSection = ''
    trimmedSemantic = true
  }
  if (estimateTokens([soulSection, groupSummarySection, userSummarySection, semanticSection]) > maxTokens && userSummarySection) {
    userSummarySection = ''
    trimmedUserSummaries = true
  }

  const systemPrompt = [soulSection, groupSummarySection, userSummarySection, semanticSection].filter(Boolean).join('\n\n')

  contextLog
    .withMetadata({
      estimatedTotalTokens: Math.ceil(systemPrompt.length / ratio),
      maxTokens,
      trimmedSemantic,
      trimmedUserSummaries,
      hasGroupSummary: !!groupSummary,
      userSummaryCount: userSummaryMap.size,
      semanticResultCount: semanticSection ? 'included' : 'none',
    })
    .info('Context assembly complete')

  // ── Chat messages：合併連續同 role 訊息 ──
  // recentMessages 來自 DB DESC 排序（最新在前），LLM 需要時間正序，先 reverse。
  // 連續的非 bot 訊息合併為單一 user message，維持 user/assistant 交替結構。
  const chatMessages = buildChatMessages([...recentMessages].reverse())

  return [
    { role: 'system', content: systemPrompt },
    ...chatMessages,
  ]
}

/**
 * 將時間正序的訊息列表轉為 user/assistant 交替的 ModelMessage[]。
 *
 * 規則：
 * - bot 訊息 → assistant role，各自獨立一則
 * - 連續的非 bot 訊息 → 合併為單一 user message（以換行分隔，每行 `{userId}: {content}`）
 *
 * WHY 合併：群聊中多人連續發言是常態，若每則都獨立為 user role，
 * 會產生連續多個 user message，不符合 LLM 預期的 user/assistant 交替格式。
 */
export function buildChatMessages(ordered: StoredMessage[]): ModelMessage[] {
  const result: ModelMessage[] = []
  let userBuffer: string[] = []

  const flushUserBuffer = () => {
    if (userBuffer.length > 0) {
      result.push({ role: 'user' as const, content: userBuffer.join('\n') })
      userBuffer = []
    }
  }

  for (const msg of ordered) {
    if (msg.isBot) {
      flushUserBuffer()
      result.push({ role: 'assistant' as const, content: msg.content })
    }
    else {
      userBuffer.push(`${msg.userId}: ${msg.content}`)
    }
  }
  flushUserBuffer()

  return result
}
