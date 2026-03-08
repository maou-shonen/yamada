import type { StoredMessage, UnifiedMessage } from '../types'
import type { DB } from './db'
import { and, count, desc, eq, gt } from 'drizzle-orm'
import * as schema from './schema'

export function saveMessage(db: DB, groupId: string, message: UnifiedMessage): void {
  db.insert(schema.messages).values({
    groupId,
    externalId: message.id,
    userId: message.userId,
    content: message.content,
    isBot: message.isBot,
    timestamp: message.timestamp.getTime(),
    replyToExternalId: message.replyToExternalId ?? null,
  }).run()
}

export function saveBotMessage(
  db: DB,
  groupId: string,
  content: string,
  botUserId: string = 'bot',
): void {
  db.insert(schema.messages).values({
    groupId,
    userId: botUserId,
    content,
    isBot: true,
    timestamp: Date.now(),
  }).run()
}

export function getRecentMessages(
  db: DB,
  groupId: string,
  limit: number,
): StoredMessage[] {
  return db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.groupId, groupId))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .all()
}

export function getMessagesSince(
  db: DB,
  groupId: string,
  since: Date,
): StoredMessage[] {
  return db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.groupId, groupId), gt(schema.messages.timestamp, since.getTime())))
    .orderBy(desc(schema.messages.timestamp))
    .all()
}

export function getMessagesByUser(
  db: DB,
  groupId: string,
  userId: string,
  limit: number,
): StoredMessage[] {
  return db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.groupId, groupId), eq(schema.messages.userId, userId)))
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
  groupId: string,
  since: number,
): string[] {
  const rows = db
    .selectDistinct({ userId: schema.messages.userId })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.groupId, groupId),
        gt(schema.messages.timestamp, since),
        eq(schema.messages.isBot, false),
      ),
    )
    .all()

  return rows.map(r => r.userId)
}

export function getMessageCount(db: DB, groupId: string): number {
  const result = db
    .select({ count: count() })
    .from(schema.messages)
    .where(eq(schema.messages.groupId, groupId))
    .get()

  return result?.count ?? 0
}
