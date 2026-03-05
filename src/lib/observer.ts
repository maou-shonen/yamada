import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import type { VectorStore } from '../storage/vector-store'
import { count, gt } from 'drizzle-orm'
import { log } from '../logger'
import { buildGroupCompressionPrompt, buildUserCompressionPrompt, formatChatHistory } from '../prompts/observer'
import { processNewFactEmbeddings } from '../storage/embedding'
import {
  getAllActiveFacts,
  getFactWatermark,
  getPinnedFacts,
  setFactWatermark,
  supersedeFact,
  upsertFact,
} from '../storage/facts'
import { getDistinctUserIds, getMessagesByUser, getMessagesSince } from '../storage/messages'
import * as schema from '../storage/schema'
import {
  getGroupSummary,
  getUserSummary,
  upsertGroupSummary,
  upsertUserSummary,
} from '../storage/summaries'
import { getAliasMap } from '../storage/user-aliases'
import { createUserMask } from './alias-replacer.ts'
import { extractFacts } from './fact-extractor.ts'
import { generateWithFallback } from './llm-utils.ts'

const observerLog = log.withPrefix('[Observer]')

export interface ObserverDeps {
  getMessagesSince: typeof getMessagesSince
  getMessagesByUser: typeof getMessagesByUser
  getDistinctUserIds: typeof getDistinctUserIds
  extractFacts: typeof extractFacts
  upsertFact: typeof upsertFact
  supersedeFact: typeof supersedeFact
  getAllActiveFacts: typeof getAllActiveFacts
  getPinnedFacts: typeof getPinnedFacts
  getFactWatermark: typeof getFactWatermark
  setFactWatermark: typeof setFactWatermark
  processNewFactEmbeddings: typeof processNewFactEmbeddings
  generateWithFallback: typeof generateWithFallback
  getGroupSummary: typeof getGroupSummary
  upsertGroupSummary: typeof upsertGroupSummary
  getUserSummary: typeof getUserSummary
  upsertUserSummary: typeof upsertUserSummary
  getAliasMap: (db: DB, userIds: string[]) => Promise<Map<string, { alias: string, userName: string }>>
}

const defaultDeps: ObserverDeps = {
  getMessagesSince,
  getMessagesByUser,
  getDistinctUserIds,
  extractFacts,
  upsertFact,
  supersedeFact,
  getAllActiveFacts,
  getPinnedFacts,
  getFactWatermark,
  setFactWatermark,
  processNewFactEmbeddings,
  generateWithFallback,
  getGroupSummary,
  upsertGroupSummary,
  getUserSummary,
  upsertUserSummary,
  getAliasMap,
}

/**
 * 取得群組摘要的 watermark（上次壓縮的時間戳）。
 * 若無既有摘要（首次壓縮），回傳 0，代表取全部歷史。
 */
function getWatermark(db: DB): number {
  const row = db
    .select({ updatedAt: schema.groupSummaries.updatedAt })
    .from(schema.groupSummaries)
    .get()

  return row?.updatedAt ?? 0
}

/**
 * 檢查是否應該觸發 Observer。
 *
 * 使用 group_summaries.updated_at 作為 watermark，只計算新增訊息。
 * 若無既有摘要（首次），計算全部訊息。
 */
export function shouldRun(db: DB, config: Config): boolean {
  const watermark = getWatermark(db)

  const whereClause = watermark > 0
    ? gt(schema.messages.timestamp, watermark)
    : undefined

  const countResult = db
    .select({ count: count() })
    .from(schema.messages)
    .where(whereClause)
    .get() as { count: number } | undefined

  const msgCount = countResult?.count ?? 0
  const shouldTrigger = msgCount >= config.OBSERVER_MESSAGE_THRESHOLD

  observerLog
    .withMetadata({
      messagesSinceLastCompress: msgCount,
      threshold: config.OBSERVER_MESSAGE_THRESHOLD,
      shouldTrigger,
    })
    .debug('Observer check')

  return shouldTrigger
}

/**
 * 壓縮群組摘要。
 *
 * 基於「舊摘要 + watermark 之後的新訊息」增量壓縮。
 * 首次壓縮（無舊摘要）時 watermark = 0，等同取全部歷史。
 *
 * @param db - 群組 DB 實例
 * @param watermark - 由 runObserver 頂層擷取並傳入，避免與 upsertGroupSummary 更新的 watermark 競態
 * @param config - 應用程式設定
 * @param deps - 可注入的依賴（測試用）
 */
export async function compressGroupSummary(
  db: DB,
  watermark: number,
  config: Config,
  deps: ObserverDeps = defaultDeps,
  pinnedFacts?: string,
): Promise<void> {
  observerLog.info('Compressing group summary')

  const messages = deps.getMessagesSince(db, new Date(watermark))
  const existingSummary = await deps.getGroupSummary(db)

  observerLog.withMetadata({ messageCount: messages.length, hasExisting: !!existingSummary }).debug('Group summary compression data')

  // 取得 userIds 並查詢 alias map
  const userIds = [...new Set(messages.filter(m => !m.isBot).map(m => m.userId))]
  const fullAliasMap = await deps.getAliasMap(db, userIds)
  const aliasMap = new Map([...fullAliasMap.entries()].map(([uid, v]) => [uid, v.alias]))

  const historyText = formatChatHistory(messages, aliasMap)
  const prompt = buildGroupCompressionPrompt(existingSummary, historyText, pinnedFacts)

  const text = await deps.generateWithFallback(prompt, config)

  await deps.upsertGroupSummary(db, text)
  observerLog.withMetadata({ summaryLength: text.length }).info('Group summary compressed')
}

/**
 * 壓縮用戶摘要。
 *
 * 基於「舊摘要 + 該用戶的最近 N 則訊息」增量壓縮。
 * 逐個用戶處理——每個用戶的人格側寫需要個別關注，批次處理會混淆身份。
 *
 * @param db - 群組 DB 實例
 * @param watermark - 由 runObserver 頂層擷取並傳入，避免與 compressGroupSummary 更新的 watermark 競態
 * @param userIds - 需要壓縮摘要的使用者 ID 列表
 * @param config - 應用程式設定
 * @param deps - 可注入的依賴（測試用）
 */
export async function compressUserSummaries(
  db: DB,
  watermark: number,
  userIds: string[],
  config: Config,
  deps: ObserverDeps = defaultDeps,
  pinnedFactsMap?: Map<string, string>,
): Promise<void> {
  observerLog.withMetadata({ userCount: userIds.length }).info('Compressing user summaries')

  for (const userId of userIds) {
    const messages = deps.getMessagesByUser(db, userId, config.OBSERVER_USER_MESSAGE_LIMIT)
    const existingSummary = await deps.getUserSummary(db, userId)
    const pinnedFacts = pinnedFactsMap?.get(userId)

    const messagesText = messages.map(m => m.content).join('\n')
    const prompt = buildUserCompressionPrompt(existingSummary, messagesText, pinnedFacts)

    const text = await deps.generateWithFallback(prompt, config)

    await deps.upsertUserSummary(db, userId, text)
    observerLog.withMetadata({ userId, summaryLength: text.length }).debug('User summary compressed')
  }
  observerLog.withMetadata({ userCount: userIds.length }).info('All user summaries compressed')
}

/**
 * 執行 facts 萃取階段，並在成功時推進 fact watermark 與更新向量索引。
 *
 * WHY：把「讀訊息 → 呼叫 LLM → 寫回 facts → 更新 watermark/embed」集中在單一 helper，
 * 讓 runObserver 主流程保留高層步驟，降低認知負擔。
 */
async function runFactExtraction(
  db: DB,
  vectorStore: VectorStore,
  config: Config,
  deps: ObserverDeps,
) {
  // 在取訊息前先記錄時間戳，避免 extraction 執行期間新訊息被 watermark 跳過
  const factExtractionStartTime = Date.now()
  const factWatermark = deps.getFactWatermark(db)
  const messagesSinceFactWatermark = deps.getMessagesSince(db, new Date(factWatermark))

  // 首次執行（factWatermark=0）會載入全部歷史，限制筆數避免 prompt 過大
  const nonBotMessages = messagesSinceFactWatermark
    .filter(m => !m.isBot)
    .slice(-200)

  const allActiveFacts = deps.getAllActiveFacts(db)
  const existingFacts = allActiveFacts
    .filter((fact): fact is typeof fact & { scope: 'user' | 'group' } => fact.scope === 'user' || fact.scope === 'group')

  try {
    const allFactUserIds = [...new Set([
      ...nonBotMessages.map(m => m.userId),
      ...existingFacts.flatMap(f => f.userId !== null ? [f.userId] : []),
    ])]
    const aliasMap = await deps.getAliasMap(db, allFactUserIds)
    const userMask = createUserMask(aliasMap)

    const factMessages = nonBotMessages.map(m => ({
      userId: userMask.mask(m.userId),
      userName: aliasMap.get(m.userId)?.alias ?? aliasMap.get(m.userId)?.userName ?? m.userId,
      content: m.content,
      createdAt: m.timestamp,
    }))

    const maskedExistingFacts = existingFacts.map(f => ({
      ...f,
      userId: f.userId !== null ? userMask.mask(f.userId) : null,
    }))

    const results = await deps.extractFacts(factMessages, maskedExistingFacts, config, userMask)

    for (const result of results) {
      if (result.action === 'supersede' && result.targetFactId !== undefined)
        deps.supersedeFact(db, result.targetFactId)

      deps.upsertFact(db, {
        scope: result.scope,
        userId: result.userId ?? null,
        canonicalKey: result.canonicalKey,
        content: result.content,
        confidence: result.confidence,
      })
    }

    // 先推進 watermark 再處理 embedding——embedding 失敗不應阻擋 watermark 前進，
    // 否則相同訊息會被重複萃取，導致 evidence_count 膨脹
    deps.setFactWatermark(db, factExtractionStartTime)
    if (results.length > 0) {
      await deps.processNewFactEmbeddings(vectorStore, db, config)
    }
  }
  catch (err) {
    observerLog.withError(err instanceof Error ? err : new Error(String(err))).warn('Fact extraction failed, continuing with summary compression')
  }

  // NOTE: 回傳 extraction 前的 snapshot——新萃取的 facts 不在其中。
  // 目前安全：新 facts 預設 pinned=false，不會影響 collectPinnedFacts。
  // 若未來允許萃取時設定 pinned=true 或更新既有 pinned fact 的 content，
  // 需改為在 extraction 後重新讀取。
  return allActiveFacts
}

/**
 * 收集 pinned facts，分為群組層級與使用者層級，供摘要壓縮 prompt 注入。
 *
 * WHY：一次在記憶體分組可避免 per-user N+1 查詢，也讓 pinned 組裝邏輯可獨立測讀。
 */
function collectPinnedFacts(
  allActiveFacts: ReturnType<ObserverDeps['getAllActiveFacts']>,
  userIds: string[],
): { groupPinnedText: string | undefined, userPinnedTextMap: Map<string, string> } {
  const allPinnedFacts = allActiveFacts.filter(f => f.pinned)
  const groupPinnedText = allPinnedFacts
    .filter(f => f.scope === 'group')
    .map(f => f.content)
    .join('\n') || undefined

  const userPinnedTextMap = new Map<string, string>()
  for (const userId of userIds) {
    const userPinned = allPinnedFacts.filter(f => f.scope === 'user' && f.userId === userId)
    if (userPinned.length > 0)
      userPinnedTextMap.set(userId, userPinned.map(f => f.content).join('\n'))
  }

  return { groupPinnedText, userPinnedTextMap }
}

/**
 * 完整 Observer 流程。
 *
 * 增量壓縮迴圈：
 * 1. shouldRun 用 watermark 計算新訊息數是否達 threshold
 * 2. getDistinctUserIds 用 watermark 只取新訊息中的活躍用戶（不載入完整 row）
 * 3. compressGroupSummary / compressUserSummaries 各自用 watermark 只取新訊息
 * 4. upsertGroupSummary 更新 updated_at → 成為下次的 watermark
 */
export async function runObserver(
  db: DB,
  vectorStore: VectorStore,
  config: Config,
  deps: ObserverDeps = defaultDeps,
): Promise<void> {
  // ── 1) 應否觸發 Observer ──
  if (!shouldRun(db, config)) {
    observerLog.debug('Observer skipped (threshold not met)')
    return
  }

  observerLog.info('Observer triggered')

  // 在頂層擷取 watermark 並傳遞給兩個 compress 函式，
  // 避免 compressGroupSummary 更新 updated_at 後影響 compressUserSummaries 讀到的 watermark
  const watermark = getWatermark(db)
  const userIds = deps.getDistinctUserIds(db, watermark)

  // ── 2) Facts 萃取 ──
  const allActiveFacts = await runFactExtraction(db, vectorStore, config, deps)

  // ── 3) 收集 pinned facts，執行摘要壓縮 ──
  const { groupPinnedText, userPinnedTextMap } = collectPinnedFacts(allActiveFacts, userIds)

  await compressGroupSummary(db, watermark, config, deps, groupPinnedText)

  if (userIds.length > 0) {
    await compressUserSummaries(db, watermark, userIds, config, deps, userPinnedTextMap)
  }
}
