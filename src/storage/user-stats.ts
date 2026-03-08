import type { DB } from './db'
import { and, eq, gte, sql } from 'drizzle-orm'
import * as schema from './schema'

export interface UserDailyStats {
  messageCount: number
  stickerCount: number
  urlCount: number
  mentionCount: number
}

/** 多日累計（結構同 UserDailyStats） */
export type UserStatsAggregate = UserDailyStats

/** UPSERT 累加當日 row：messageCount 永遠 +1，其他根據 flag */
export function recordActivity(
  db: DB,
  groupId: string,
  params: {
    userId: string
    date: string
    isSticker: boolean
    hasUrl: boolean
    isMention: boolean
  },
): void {
  const { userId, date, isSticker, hasUrl, isMention } = params

  db.insert(schema.userStats)
    .values({
      groupId,
      userId,
      date,
      messageCount: 1,
      stickerCount: isSticker ? 1 : 0,
      urlCount: hasUrl ? 1 : 0,
      mentionCount: isMention ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [schema.userStats.groupId, schema.userStats.userId, schema.userStats.date],
      set: {
        messageCount: sql`${schema.userStats.messageCount} + 1`,
        stickerCount: sql`${schema.userStats.stickerCount} + ${isSticker ? 1 : 0}`,
        urlCount: sql`${schema.userStats.urlCount} + ${hasUrl ? 1 : 0}`,
        mentionCount: sql`${schema.userStats.mentionCount} + ${isMention ? 1 : 0}`,
      },
    })
    .run()
}

export function getUserDailyStats(
  db: DB,
  groupId: string,
  userId: string,
  date: string,
): UserDailyStats | undefined {
  const row = db
    .select({
      messageCount: schema.userStats.messageCount,
      stickerCount: schema.userStats.stickerCount,
      urlCount: schema.userStats.urlCount,
      mentionCount: schema.userStats.mentionCount,
    })
    .from(schema.userStats)
    .where(
      and(
        eq(schema.userStats.groupId, groupId),
        eq(schema.userStats.userId, userId),
        eq(schema.userStats.date, date),
      ),
    )
    .get()

  return row
}

export function getUserStatsSince(
  db: DB,
  groupId: string,
  userId: string,
  sinceDate: string,
): UserStatsAggregate {
  const row = db
    .select({
      messageCount: sql<number>`COALESCE(SUM(${schema.userStats.messageCount}), 0)`,
      stickerCount: sql<number>`COALESCE(SUM(${schema.userStats.stickerCount}), 0)`,
      urlCount: sql<number>`COALESCE(SUM(${schema.userStats.urlCount}), 0)`,
      mentionCount: sql<number>`COALESCE(SUM(${schema.userStats.mentionCount}), 0)`,
    })
    .from(schema.userStats)
    .where(
      and(
        eq(schema.userStats.groupId, groupId),
        eq(schema.userStats.userId, userId),
        gte(schema.userStats.date, sinceDate),
      ),
    )
    .get()

  return (
    row ?? {
      messageCount: 0,
      stickerCount: 0,
      urlCount: 0,
      mentionCount: 0,
    }
  )
}
