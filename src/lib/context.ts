import type { ModelMessage } from 'ai'
import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { Fact } from '../storage/facts'
import type { SqliteVectorStore } from '../storage/sqlite-vector-store'
import type { VectorStore } from '../storage/vector-store'
import type { StoredImage, StoredMessage } from '../types'
import { log } from '../logger'
import { getChunkContents } from '../storage/chunks'
import { embedText } from './embedding'
import { getAllActiveFacts } from '../storage/facts'
import { getImagesForMessages } from '../storage/images'
import { getGroupSummary, getUserSummariesForGroup } from '../storage/summaries'
import { getAliasMap } from '../storage/user-aliases'
import { replaceUserIdsWithAliases } from './alias-replacer'

const contextLog = log.withPrefix('[Context]')

export interface ContextDeps {
  getUserSummariesForGroup: typeof getUserSummariesForGroup
  getGroupSummary: typeof getGroupSummary
  embedText: typeof embedText
  getChunkContents: typeof getChunkContents
  getAliasMap: (db: DB, groupId: string, userIds: string[]) => Promise<Map<string, { alias: string, userName: string }>>
  getAllActiveFacts: typeof getAllActiveFacts
  getImagesForMessages: typeof getImagesForMessages
}

const defaultDeps: ContextDeps = {
  getUserSummariesForGroup,
  getGroupSummary,
  embedText,
  getChunkContents,
  getAliasMap,
  getAllActiveFacts,
  getImagesForMessages,
}

export interface AssembleContextParams {
  recentMessages: StoredMessage[]
  config: Config
  db: DB
  groupId: string
  vectorStore: VectorStore
  deps?: ContextDeps
}

interface TrimmableSection {
  name: string
  budgetKey?: string
  getValue: () => string
  setValue: (v: string) => void
  fallback: () => string
  canTrim: () => boolean
}

/**
 * 依優先序裁剪可移除區塊，直到 token 回到預算內或無區塊可裁。
 *
 * WHY：把重複的「超預算就移除某段」邏輯統一成資料驅動流程，
 * 讓裁剪順序與條件可明確閱讀與維護。
 */
function trimSections(
  sections: TrimmableSection[],
  maxTokens: number,
  ratio: number,
): Set<string> {
  const estimateTokens = () => {
    const uniqueValues = new Map<string, string>()
    for (const section of sections) {
      const key = section.budgetKey ?? section.name
      if (!uniqueValues.has(key))
        uniqueValues.set(key, section.getValue())
    }

    return Math.ceil([...uniqueValues.values()].filter(Boolean).join('').length / ratio)
  }

  const trimmed = new Set<string>()

  for (const section of sections) {
    if (estimateTokens() <= maxTokens)
      break

    while (estimateTokens() > maxTokens && section.canTrim()) {
      const current = section.getValue()
      const next = section.fallback()
      section.setValue(next)
      trimmed.add(section.name)

      if (next === current)
        break
    }
  }

  return trimmed
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
  const { recentMessages, config, db, groupId, vectorStore } = params
  const deps = params.deps ?? defaultDeps

  contextLog.withMetadata({ recentMessageCount: recentMessages.length }).info('Assembling context')

  const ratio = config.CONTEXT_TOKEN_ESTIMATE_RATIO

  // ── 各區塊收集 ──

  const soulSection = `<soul>\n${config.SOUL}\n</soul>`

  let groupSummarySection = ''
  const groupSummary = await deps.getGroupSummary(db, groupId)
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
  const userSummaryMap = await deps.getUserSummariesForGroup(db, groupId, nonBotUserIds)
  const aliasMap = await deps.getAliasMap(db, groupId, nonBotUserIds)
  const userIdToAliasMap = new Map(
    [...aliasMap.entries()].map(([uid, { alias }]) => [uid, alias]),
  )
  let userSummarySection = ''
  if (userSummaryMap.size > 0) {
    const lines = [...userSummaryMap.entries()].map(([uid, summary]) => `${aliasMap.get(uid)?.alias ?? uid}: ${summary}`)
    userSummarySection = `<user_profiles>\n${lines.join('\n')}\n</user_profiles>`
    contextLog.withMetadata({ userCount: userSummaryMap.size }).debug('User summaries loaded')
  }

  // ── Facts：建立查找池（facts pool）──
  // 取得所有 active facts（含 user + group，pinned + non-pinned）建立完整查找池
  // 必須包含所有 active facts，否則語義搜尋回傳的 non-pinned user facts 會找不到對應資料
  const allActiveFacts = deps.getAllActiveFacts(db, groupId)
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

        // Chunk 語義搜尋（group-scoped if available）
        const similar = 'searchChunksForGroup' in vectorStore
          ? (vectorStore as SqliteVectorStore).searchChunksForGroup(groupId, queryEmbedding, config.CONTEXT_SEMANTIC_TOP_K, config.CONTEXT_SEMANTIC_THRESHOLD)
          : vectorStore.searchChunks(queryEmbedding, config.CONTEXT_SEMANTIC_TOP_K, config.CONTEXT_SEMANTIC_THRESHOLD)
        contextLog.withMetadata({ resultsCount: similar.length }).debug('Semantic search results')
        if (similar.length > 0) {
          const chunkIds = similar.map(s => s.id)
          const contents = deps.getChunkContents(db, groupId, chunkIds)
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

  // ── Facts：語義搜尋（fact semantic search）──
  // Fact 語義搜尋（獨立容錯，embedding 失敗時自然跳過）
  const searchedFacts: Fact[] = []
  if (queryEmbedding) {
    try {
      const factResults = 'searchFactsForGroup' in vectorStore
        ? (vectorStore as SqliteVectorStore).searchFactsForGroup(groupId, queryEmbedding, config.CONTEXT_FACT_TOP_K, config.CONTEXT_FACT_THRESHOLD)
        : vectorStore.searchFacts(queryEmbedding, config.CONTEXT_FACT_TOP_K, config.CONTEXT_FACT_THRESHOLD)
      for (const { id: factId } of factResults) {
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

  // ── Facts：組裝輸出區塊（facts section assembly）──
  // 分離 pinned 與 searched facts，供 trimming 時優先移除 searched
  // FACT_MAX_PINNED 限制每位用戶（及群組）的 pinned facts 上限，避免 system prompt 無限膨脹
  // 以 id（插入順序）排序確保裁剪結果穩定可預測
  const allPinnedFacts = [...factsById.values()].filter(f => f.pinned).sort((a, b) => a.id - b.id)
  const groupFactsPinned = allPinnedFacts.filter(f => f.scope === 'group').slice(0, config.FACT_MAX_PINNED)
  const groupFactsSearched = searchedFacts.filter(f => f.scope === 'group')

  // 用戶 pinned facts 按 user 分組後各自限制上限
  // allPinnedFacts 已排序，分組後各 user 內部維持 id 順序
  const allUserPinned = allPinnedFacts.filter(f => f.scope === 'user')
  const userPinnedByUser = new Map<string, typeof allUserPinned>()
  for (const f of allUserPinned) {
    const uid = f.userId ?? ''
    const arr = userPinnedByUser.get(uid) ?? []
    arr.push(f)
    userPinnedByUser.set(uid, arr)
  }
  const userFactsPinned = [...userPinnedByUser.values()].flatMap(facts => facts.slice(0, config.FACT_MAX_PINNED))
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

  // ── Token 預算裁剪：準備上下文狀態 ──
  // 裁剪順序（最先移除 → 最後移除）：
  // related_history → user_facts searched → group_facts searched → user_profiles → group_summary
  // SOUL 永不裁剪。Facts 中先移除 searched（non-pinned），盡量保留 pinned。
  const maxTokens = config.CONTEXT_MAX_TOKENS

  // ── Token 預算裁剪：建立裁剪優先序 ──
  let userPinnedRemain = userFactsPinned.length
  let groupPinnedRemain = groupFactsPinned.length

  const trimmableSections: TrimmableSection[] = [
    {
      name: 'soul',
      getValue: () => soulSection,
      setValue: () => {},
      fallback: () => soulSection,
      canTrim: () => false,
    },
    {
      name: 'semantic',
      getValue: () => semanticSection,
      setValue: (value) => { semanticSection = value },
      fallback: () => '',
      canTrim: () => !!semanticSection,
    },
    {
      name: 'user_facts_searched',
      budgetKey: 'user_facts_section',
      getValue: () => userFactsSection,
      setValue: (value) => { userFactsSection = value },
      fallback: () => buildUserFactsXml(userFactsPinned),
      canTrim: () => userFactsSearched.length > 0 && userFactsSection !== buildUserFactsXml(userFactsPinned),
    },
    {
      name: 'group_facts_searched',
      budgetKey: 'group_facts_section',
      getValue: () => groupFactsSection,
      setValue: (value) => { groupFactsSection = value },
      fallback: () => buildGroupFactsXml(groupFactsPinned),
      canTrim: () => groupFactsSearched.length > 0 && groupFactsSection !== buildGroupFactsXml(groupFactsPinned),
    },
    {
      name: 'user_profiles',
      getValue: () => userSummarySection,
      setValue: (value) => { userSummarySection = value },
      fallback: () => '',
      canTrim: () => !!userSummarySection,
    },
    {
      name: 'group_summary',
      getValue: () => groupSummarySection,
      setValue: (value) => { groupSummarySection = value },
      fallback: () => '',
      canTrim: () => !!groupSummarySection,
    },
    {
      name: 'user_facts_pinned',
      budgetKey: 'user_facts_section',
      getValue: () => userFactsSection,
      setValue: (value) => { userFactsSection = value },
      fallback: () => {
        userPinnedRemain--
        return userPinnedRemain > 0 ? buildUserFactsXml(userFactsPinned.slice(0, userPinnedRemain)) : ''
      },
      canTrim: () => userPinnedRemain > 0,
    },
    {
      name: 'group_facts_pinned',
      budgetKey: 'group_facts_section',
      getValue: () => groupFactsSection,
      setValue: (value) => { groupFactsSection = value },
      fallback: () => {
        groupPinnedRemain--
        return groupPinnedRemain > 0 ? buildGroupFactsXml(groupFactsPinned.slice(0, groupPinnedRemain)) : ''
      },
      canTrim: () => groupPinnedRemain > 0,
    },
  ]

  // ── Token 預算裁剪：依序執行裁剪 ──
  const trimmedSections = trimSections(trimmableSections, maxTokens, ratio)

  // ── Token 預算裁剪：彙整裁剪結果 ──
  const trimmedSemantic = trimmedSections.has('semantic')
  const trimmedUserFactsSearched = trimmedSections.has('user_facts_searched')
  const trimmedGroupFactsSearched = trimmedSections.has('group_facts_searched')
  const trimmedUserSummaries = trimmedSections.has('user_profiles')
  const trimmedGroupSummary = trimmedSections.has('group_summary')
  const trimmedUserFactsPinned = trimmedSections.has('user_facts_pinned')
  const trimmedGroupFactsPinned = trimmedSections.has('group_facts_pinned')

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
      pinnedFactCount: allPinnedFacts.length,
      searchedFactCount: searchedFacts.length,
      semanticResultCount: semanticSection ? 'included' : 'none',
    })
    .info('Context assembly complete')

  const imageMap = deps.getImagesForMessages(db, groupId, recentMessages.map(msg => msg.id))

  // ── Chat messages：合併連續同 role 訊息 ──
  // recentMessages 來自 DB DESC 排序（最新在前），LLM 需要時間正序，先 reverse。
  // 連續的非 bot 訊息合併為單一 user message，維持 user/assistant 交替結構。
  const chatMessages = buildChatMessages([...recentMessages].reverse(), userIdToAliasMap, imageMap)

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
export function buildChatMessages(
  ordered: StoredMessage[],
  aliasMap: Map<string, string> = new Map(),
  imageMap?: Map<number, StoredImage>,
): ModelMessage[] {
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
      let content = msg.content
      const storedImage = imageMap?.get(msg.id)
      if (storedImage?.description)
        content = content.replace('[圖片]', `[圖片 #${storedImage.id}: ${storedImage.description}]`)
      userBuffer.push(`${displayId}: ${content}`)
    }
  }
  flushUserBuffer()

  return result
}
