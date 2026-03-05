import type { DB } from './db'
import { and, eq, inArray } from 'drizzle-orm'
import * as schema from './schema'

export function getUserSummary(
  db: DB,
  groupId: string,
  userId: string,
): string | null {
  const row = db
    .select({ summary: schema.userSummaries.summary })
    .from(schema.userSummaries)
    .where(and(eq(schema.userSummaries.groupId, groupId), eq(schema.userSummaries.userId, userId)))
    .get()

  return row?.summary ?? null
}

export function upsertUserSummary(
  db: DB,
  groupId: string,
  userId: string,
  summary: string,
): void {
  db
    .insert(schema.userSummaries)
    .values({
      id: crypto.randomUUID(),
      groupId,
      userId,
      summary,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.userSummaries.groupId, schema.userSummaries.userId],
      set: {
        summary,
        updatedAt: Date.now(),
      },
    })
    .run()
}

export function getGroupSummary(
  db: DB,
  groupId: string,
): string | null {
  const row = db
    .select({ summary: schema.groupSummaries.summary })
    .from(schema.groupSummaries)
    .where(eq(schema.groupSummaries.groupId, groupId))
    .get()

  return row?.summary ?? null
}

export function upsertGroupSummary(
  db: DB,
  groupId: string,
  summary: string,
): void {
  db
    .insert(schema.groupSummaries)
    .values({
      groupId,
      summary,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.groupSummaries.groupId],
      set: {
        summary,
        updatedAt: Date.now(),
      },
    })
    .run()
}

export function getUserSummariesForGroup(
  db: DB,
  groupId: string,
  userIds: string[],
): Map<string, string> {
  if (userIds.length === 0) {
    return new Map()
  }

  const rows = db
    .select()
    .from(schema.userSummaries)
    .where(and(eq(schema.userSummaries.groupId, groupId), inArray(schema.userSummaries.userId, userIds)))
    .all()

  return new Map(rows.map(row => [row.userId, row.summary]))
}
