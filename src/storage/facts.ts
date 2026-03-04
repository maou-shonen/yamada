import type { DB } from './db'
import { and, eq, isNull } from 'drizzle-orm'
import * as schema from './schema'

/** 建立或更新 fact 的輸入型別 */
export interface FactUpsert {
  scope: 'user' | 'group'
  userId?: string | null
  canonicalKey: string
  content: string
  confidence?: number
  status?: 'active' | 'superseded' | 'contradicted'
}

/** 已儲存的 fact 型別 */
export type Fact = typeof schema.facts.$inferSelect

/** 取得指定用戶的所有 facts（依 status 過濾） */
export function getFactsByUser(db: DB, userId: string, status = 'active'): Fact[] {
  return db
    .select()
    .from(schema.facts)
    .where(
      and(
        eq(schema.facts.scope, 'user'),
        eq(schema.facts.userId, userId),
        eq(schema.facts.status, status),
      ),
    )
    .all()
}

/** 取得所有群組層級的 facts（依 status 過濾） */
export function getGroupFacts(db: DB, status = 'active'): Fact[] {
  return db
    .select()
    .from(schema.facts)
    .where(
      and(
        eq(schema.facts.scope, 'group'),
        eq(schema.facts.status, status),
      ),
    )
    .all()
}

/** 取得釘選的 facts（群組釘選 + 指定用戶的釘選） */
export function getPinnedFacts(db: DB, userId?: string): Fact[] {
  const groupPinned = db
    .select()
    .from(schema.facts)
    .where(
      and(
        eq(schema.facts.scope, 'group'),
        eq(schema.facts.pinned, true),
        eq(schema.facts.status, 'active'),
      ),
    )
    .all()

  if (!userId)
    return groupPinned

  const userPinned = db
    .select()
    .from(schema.facts)
    .where(
      and(
        eq(schema.facts.scope, 'user'),
        eq(schema.facts.userId, userId),
        eq(schema.facts.pinned, true),
        eq(schema.facts.status, 'active'),
      ),
    )
    .all()

  return [...groupPinned, ...userPinned]
}

/**
 * Upsert fact：以 (canonical_key, scope, user_id) 為唯一鍵
 * 已存在 → 更新 content/confidence/status + evidence_count++
 * 不存在 → 插入新 fact
 */
export function upsertFact(db: DB, fact: FactUpsert): void {
  const userId = fact.userId ?? null

  // 查找既有 fact：需處理 user_id 為 null 的情況
  const existing = db
    .select()
    .from(schema.facts)
    .where(
      and(
        eq(schema.facts.canonicalKey, fact.canonicalKey),
        eq(schema.facts.scope, fact.scope),
        userId === null
          ? isNull(schema.facts.userId)
          : eq(schema.facts.userId, userId),
      ),
    )
    .get()

  const now = Date.now()

  if (existing) {
    db.update(schema.facts)
      .set({
        content: fact.content,
        confidence: fact.confidence ?? existing.confidence,
        evidenceCount: existing.evidenceCount + 1,
        status: fact.status ?? 'active',
        updatedAt: now,
      })
      .where(eq(schema.facts.id, existing.id))
      .run()
  }
  else {
    db.insert(schema.facts)
      .values({
        scope: fact.scope,
        userId,
        canonicalKey: fact.canonicalKey,
        content: fact.content,
        confidence: fact.confidence ?? 1.0,
        evidenceCount: 1,
        status: fact.status ?? 'active',
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
}

/** 將指定 fact 標記為 superseded */
export function supersedeFact(db: DB, factId: number): void {
  db.update(schema.facts)
    .set({
      status: 'superseded',
      updatedAt: Date.now(),
    })
    .where(eq(schema.facts.id, factId))
    .run()
}

/** 取得所有 active 的 facts（供 fact extraction context 使用） */
export function getAllActiveFacts(db: DB): Fact[] {
  return db
    .select()
    .from(schema.facts)
    .where(eq(schema.facts.status, 'active'))
    .all()
}

/** 取得 fact extraction watermark 時間戳（未設定則回傳 0） */
export function getFactWatermark(db: DB): number {
  return db
    .select()
    .from(schema.factMetadata)
    .where(eq(schema.factMetadata.key, 'fact_watermark'))
    .get()
    ?.value ?? 0
}

/** 設定 fact extraction watermark 時間戳 */
export function setFactWatermark(db: DB, timestamp: number): void {
  db.insert(schema.factMetadata)
    .values({ key: 'fact_watermark', value: timestamp })
    .onConflictDoUpdate({
      target: schema.factMetadata.key,
      set: { value: timestamp },
    })
    .run()
}
