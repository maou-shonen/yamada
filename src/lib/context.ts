import type { ModelMessage } from 'ai'
import type { Database } from 'bun:sqlite'
import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { StoredMessage } from '../types'
import { inArray } from 'drizzle-orm'
import { log } from '../logger'
import { embedText, searchSimilar } from '../storage/embedding'
import * as schema from '../storage/schema'
import { getGroupSummary, getUserSummariesForGroup } from '../storage/summaries'

const contextLog = log.withPrefix('[Context]')

export interface ContextDeps {
  getUserSummariesForGroup: typeof getUserSummariesForGroup
  getGroupSummary: typeof getGroupSummary
  embedText: typeof embedText
  searchSimilar: typeof searchSimilar
}

const defaultDeps: ContextDeps = {
  getUserSummariesForGroup,
  getGroupSummary,
  embedText,
  searchSimilar,
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
 * Why: 順序很重要——SOUL 是 bot 的身份基礎，群組摘要是共享背景，
 * 用戶摘要是個人記憶（影響人格一致性），語義搜尋是補充檢索。
 * 近期訊息最後加入，讓 LLM 看到最新的對話脈絡。
 */
export async function assembleContext(params: AssembleContextParams): Promise<ModelMessage[]> {
  const { recentMessages, config, db, sqliteDb } = params
  const deps = params.deps ?? defaultDeps

  contextLog.withMetadata({ recentMessageCount: recentMessages.length }).info('Assembling context')

  const ratio = config.CONTEXT_TOKEN_ESTIMATE_RATIO

  const soulSection = config.SOUL

  let groupSummarySection = ''
  const groupSummary = await deps.getGroupSummary(db)
  if (groupSummary) {
    groupSummarySection = `\n## 群組摘要\n${groupSummary}`
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
    userSummarySection = `\n## 用戶資料\n${lines.join('\n')}`
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
        const similar = deps.searchSimilar(
          sqliteDb,
          embedding,
          config.CONTEXT_SEMANTIC_TOP_K,
          config.CONTEXT_SEMANTIC_THRESHOLD,
        )
        contextLog.withMetadata({ resultsCount: similar.length }).debug('Semantic search results')
        if (similar.length > 0) {
          // 只查詢語義搜尋命中的 messageId，避免載入不必要的訊息
          const messageIds = similar.map(s => s.messageId)
          const matched = db
            .select({ id: schema.messages.id, content: schema.messages.content })
            .from(schema.messages)
            .where(inArray(schema.messages.id, messageIds))
            .all()
          const msgMap = new Map(matched.map(m => [m.id, m.content]))
          const contents = similar
            .map(s => msgMap.get(s.messageId))
            .filter(Boolean) as string[]
          if (contents.length > 0) {
            semanticSection = `\n## 相關歷史\n${contents.join('\n')}`
          }
        }
      }
      catch (err) {
        // 語義搜尋失敗不中斷流程，降級繼續
        contextLog.withError(err instanceof Error ? err : new Error(String(err))).warn('Semantic search failed, skipping')
      }
    }
  }

  /**
   * Token 預算裁剪：依優先序逐步移除低優先區塊。
   * 裁剪順序：semantic → userSummary。
   * Why: 語義搜尋是「錦上添花」的歷史回顧，user summary 對人格一致性更關鍵，
   * 而 SOUL 和 group summary 是不可裁剪的核心。
   */
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

  const systemPrompt = [soulSection, groupSummarySection, userSummarySection, semanticSection].filter(Boolean).join('')

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

  /**
   * Caveat: recentMessages 來自 DB 的 DESC 排序（最新在前），
   * 但 LLM 需要時間正序（最舊在前），因此做 reverse。
   */
  const ordered = [...recentMessages].reverse()
  const chatMessages: ModelMessage[] = ordered.map((msg) => {
    if (msg.isBot) {
      return { role: 'assistant' as const, content: msg.content }
    }
    return { role: 'user' as const, content: `${msg.userId}: ${msg.content}` }
  })

  return [
    { role: 'system', content: systemPrompt },
    ...chatMessages,
  ]
}
