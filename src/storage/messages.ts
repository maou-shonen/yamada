import type { StoredMessage, UnifiedMessage } from '../types'
import type { DB } from './db'
import { and, count, desc, eq, gt } from 'drizzle-orm'
import * as schema from './schema'

export function saveMessage(db: DB, message: UnifiedMessage): void {
  db.insert(schema.messages).values({
    externalId: message.id,
    userId: message.userId,
    content: message.content,
    isBot: message.isBot,
    timestamp: message.timestamp.getTime(),
  }).run()
}

export function saveBotMessage(
  db: DB,
  content: string,
  botUserId: string = 'bot',
): void {
  db.insert(schema.messages).values({
    userId: botUserId,
    content,
    isBot: true,
    timestamp: Date.now(),
  }).run()
}

export function getRecentMessages(
  db: DB,
  limit: number,
): StoredMessage[] {
  return db
    .select()
    .from(schema.messages)
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .all()
}

export function getMessagesSince(
  db: DB,
  since: Date,
): StoredMessage[] {
  return db
    .select()
    .from(schema.messages)
    .where(gt(schema.messages.timestamp, since.getTime()))
    .orderBy(desc(schema.messages.timestamp))
    .all()
}

export function getMessagesByUser(
  db: DB,
  userId: string,
  limit: number,
): StoredMessage[] {
  return db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.userId, userId))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .all()
}

/**
 * 取得 watermark 之後的不重複非 bot 用戶 ID。
 * 用於 Observer 增量壓縮——只需知道「誰在新訊息中發過言」，不需載入完整 row。
 */
export function getDistinctUserIds(
  db: DB,
  since: number,
): string[] {
  const rows = db
    .selectDistinct({ userId: schema.messages.userId })
    .from(schema.messages)
    .where(
      and(
        gt(schema.messages.timestamp, since),
        eq(schema.messages.isBot, false),
      ),
    )
    .all()

  return rows.map(r => r.userId)
}

export function getMessageCount(db: DB): number {
  const result = db
    .select({ count: count() })
    .from(schema.messages)
    .get()

  return result?.count ?? 0
}
