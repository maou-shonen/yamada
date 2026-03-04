import type { ModelMessage } from 'ai'
import type { Database } from 'bun:sqlite'
import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { Fact } from '../storage/facts'
import type { StoredMessage } from '../types'
import { log } from '../logger'
import { getChunkContents } from '../storage/chunks'
import { embedText, searchSimilarChunks, searchSimilarFacts } from '../storage/embedding'
import { getAllActiveFacts, getGroupFacts, getPinnedFacts } from '../storage/facts'
import { getGroupSummary, getUserSummariesForGroup } from '../storage/summaries'
import { getAliasMap } from '../storage/user-aliases'
import { replaceUserIdsWithAliases } from './alias-replacer'

const contextLog = log.withPrefix('[Context]')

export interface ContextDeps {
  getUserSummariesForGroup: typeof getUserSummariesForGroup
  getGroupSummary: typeof getGroupSummary
  embedText: typeof embedText
  searchSimilarChunks: typeof searchSimilarChunks
  getChunkContents: typeof getChunkContents
  getAliasMap: (db: DB, userIds: string[]) => Promise<Map<string, { alias: string, userName: string }>>
  getAllActiveFacts: typeof getAllActiveFacts
  getPinnedFacts: typeof getPinnedFacts
  getGroupFacts: typeof getGroupFacts
  searchSimilarFacts: typeof searchSimilarFacts
}

const defaultDeps: ContextDeps = {
  getUserSummariesForGroup,
  getGroupSummary,
  embedText,
  searchSimilarChunks,
  getChunkContents,
  getAliasMap,
  getAllActiveFacts,
  getPinnedFacts,
  getGroupFacts,
  searchSimilarFacts,
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
 * 優先序：SOUL > 群組摘要 > 群組 facts > 用戶資料 > 用戶 facts > 相關歷史。
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
  const aliasMap = await deps.getAliasMap(db, nonBotUserIds)
  const userIdToAliasMap = new Map(
    [...aliasMap.entries()].map(([uid, { alias }]) => [uid, alias]),
  )
  let userSummarySection = ''
  if (userSummaryMap.size > 0) {
    const lines = [...userSummaryMap.entries()].map(([uid, summary]) => `${aliasMap.get(uid)?.alias ?? uid}: ${summary}`)
    userSummarySection = `<user_profiles>\n${lines.join('\n')}\n</user_profiles>`
    contextLog.withMetadata({ userCount: userSummaryMap.size }).debug('User summaries loaded')
  }

  // ── Facts 收集 ──
  // 取得所有 active facts（含 user + group，pinned + non-pinned）建立完整查找池
  // 必須包含所有 active facts，否則語義搜尋回傳的 non-pinned user facts 會找不到對應資料
  const allActiveFacts = deps.getAllActiveFacts(db)
  const factsById = new Map(allActiveFacts.map(f => [f.id, f]))

  // ── 語義搜尋：chunk + facts ──
  // 共用同一次 embedding 計算，chunk 與 fact 搜尋各自容錯
  let semanticSection = ''
  let queryEmbedding: number[] | null = null

  if (config.embeddingEnabled) {
    const lastNonBot = [...recentMessages].reverse().find(m => !m.isBot)
    if (lastNonBot) {
      try {
        contextLog.withMetadata({ query: lastNonBot.content.slice(0, 60) }).debug('Running semantic search')
        queryEmbedding = await deps.embedText(lastNonBot.content, config)

        // Chunk 語義搜尋
        const similar = deps.searchSimilarChunks(
          sqliteDb,
          queryEmbedding,
          config.CONTEXT_SEMANTIC_TOP_K,
          config.CONTEXT_SEMANTIC_THRESHOLD,
        )
        contextLog.withMetadata({ resultsCount: similar.length }).debug('Semantic search results')
        if (similar.length > 0) {
          const chunkIds = similar.map(s => s.chunkId)
          const contents = deps.getChunkContents(db, chunkIds)
          if (contents.length > 0) {
            const replacedContents = contents.map(content => replaceUserIdsWithAliases(content, userIdToAliasMap))
            semanticSection = `<related_history>\n${replacedContents.join('\n')}\n</related_history>`
          }
        }
      }
      catch (err) {
        // embedding 或 chunk 搜尋失敗不中斷流程，降級繼續
        contextLog.withError(err instanceof Error ? err : new Error(String(err))).warn('Semantic search failed, skipping')
      }
    }
  }

  // Fact 語義搜尋（獨立容錯，embedding 失敗時自然跳過）
  const searchedFacts: Fact[] = []
  if (queryEmbedding) {
    try {
      const factResults = deps.searchSimilarFacts(
        sqliteDb,
        queryEmbedding,
        config.CONTEXT_FACT_TOP_K,
        config.CONTEXT_FACT_THRESHOLD,
      )
      for (const { factId } of factResults) {
        const fact = factsById.get(factId)
        if (fact && fact.confidence >= config.FACT_CONFIDENCE_THRESHOLD && !fact.pinned) {
          searchedFacts.push(fact)
        }
      }
      contextLog.withMetadata({ searchedFactCount: searchedFacts.length }).debug('Fact semantic search results')
    }
    catch (err) {
      contextLog.withError(err instanceof Error ? err : new Error(String(err))).warn('Fact semantic search failed, skipping')
    }
  }

  // ── Facts 區塊組裝 ──
  // 分離 pinned 與 searched facts，供 trimming 時優先移除 searched
  const pinnedFacts = [...factsById.values()].filter(f => f.pinned)
  const groupFactsPinned = pinnedFacts.filter(f => f.scope === 'group')
  const groupFactsSearched = searchedFacts.filter(f => f.scope === 'group')
  const userFactsPinned = pinnedFacts.filter(f => f.scope === 'user')
  const userFactsSearched = searchedFacts.filter(f => f.scope === 'user')

  const buildGroupFactsXml = (facts: Fact[]) => {
    if (facts.length === 0)
      return ''
    return `<group_facts>\n${facts.map(f => f.content).join('\n')}\n</group_facts>`
  }

  const buildUserFactsXml = (facts: Fact[]) => {
    if (facts.length === 0)
      return ''
    const lines = facts.map((f) => {
      const alias = aliasMap.get(f.userId ?? '')?.alias ?? f.userId ?? ''
      return `${alias}: ${f.content}`
    })
    return `<user_facts>\n${lines.join('\n')}\n</user_facts>`
  }

  let groupFactsSection = buildGroupFactsXml([...groupFactsPinned, ...groupFactsSearched])
  let userFactsSection = buildUserFactsXml([...userFactsPinned, ...userFactsSearched])

  // ── Token 預算裁剪 ──
  // 裁剪順序（最先移除 → 最後移除）：
  // related_history → user_facts searched → group_facts searched → user_profiles → group_summary
  // SOUL 永不裁剪。Facts 中先移除 searched（non-pinned），盡量保留 pinned。
  const maxTokens = config.CONTEXT_MAX_TOKENS
  const allParts = () => [soulSection, groupSummarySection, groupFactsSection, userSummarySection, userFactsSection, semanticSection]
  const estimateTokens = (parts: string[]) => Math.ceil(parts.filter(Boolean).join('').length / ratio)
  let trimmedSemantic = false
  let trimmedUserFactsSearched = false
  let trimmedGroupFactsSearched = false
  let trimmedUserSummaries = false
  let trimmedGroupSummary = false
  let trimmedUserFactsPinned = false
  let trimmedGroupFactsPinned = false

  if (estimateTokens(allParts()) > maxTokens && semanticSection) {
    semanticSection = ''
    trimmedSemantic = true
  }
  if (estimateTokens(allParts()) > maxTokens && userFactsSearched.length > 0) {
    userFactsSection = buildUserFactsXml(userFactsPinned)
    trimmedUserFactsSearched = true
  }
  if (estimateTokens(allParts()) > maxTokens && groupFactsSearched.length > 0) {
    groupFactsSection = buildGroupFactsXml(groupFactsPinned)
    trimmedGroupFactsSearched = true
  }
  if (estimateTokens(allParts()) > maxTokens && userSummarySection) {
    userSummarySection = ''
    trimmedUserSummaries = true
  }
  if (estimateTokens(allParts()) > maxTokens && groupSummarySection) {
    groupSummarySection = ''
    trimmedGroupSummary = true
  }
  // Pinned facts 通常很小，但極端情況下仍可能超出預算——逐筆移除
  if (estimateTokens(allParts()) > maxTokens && userFactsPinned.length > 0) {
    for (let i = userFactsPinned.length - 1; i >= 0; i--) {
      userFactsSection = i > 0 ? buildUserFactsXml(userFactsPinned.slice(0, i)) : ''
      trimmedUserFactsPinned = true
      if (estimateTokens(allParts()) <= maxTokens)
        break
    }
  }
  if (estimateTokens(allParts()) > maxTokens && groupFactsPinned.length > 0) {
    for (let i = groupFactsPinned.length - 1; i >= 0; i--) {
      groupFactsSection = i > 0 ? buildGroupFactsXml(groupFactsPinned.slice(0, i)) : ''
      trimmedGroupFactsPinned = true
      if (estimateTokens(allParts()) <= maxTokens)
        break
    }
  }

  // Context 順序：SOUL > group_summary > group_facts > user_profiles > user_facts > related_history
  const systemPrompt = [soulSection, groupSummarySection, groupFactsSection, userSummarySection, userFactsSection, semanticSection].filter(Boolean).join('\n\n')

  contextLog
    .withMetadata({
      estimatedTotalTokens: Math.ceil(systemPrompt.length / ratio),
      maxTokens,
      trimmedSemantic,
      trimmedUserFactsSearched,
      trimmedGroupFactsSearched,
      trimmedUserSummaries,
      trimmedGroupSummary,
      trimmedUserFactsPinned,
      trimmedGroupFactsPinned,
      hasGroupSummary: !!groupSummary,
      userSummaryCount: userSummaryMap.size,
      pinnedFactCount: pinnedFacts.length,
      searchedFactCount: searchedFacts.length,
      semanticResultCount: semanticSection ? 'included' : 'none',
    })
    .info('Context assembly complete')

  // ── Chat messages：合併連續同 role 訊息 ──
  // recentMessages 來自 DB DESC 排序（最新在前），LLM 需要時間正序，先 reverse。
  // 連續的非 bot 訊息合併為單一 user message，維持 user/assistant 交替結構。
  const chatMessages = buildChatMessages([...recentMessages].reverse(), userIdToAliasMap)

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
export function buildChatMessages(ordered: StoredMessage[], aliasMap: Map<string, string> = new Map()): ModelMessage[] {
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
      const displayId = aliasMap.get(msg.userId) ?? msg.userId
      userBuffer.push(`${displayId}: ${msg.content}`)
    }
  }
  flushUserBuffer()

  return result
}
