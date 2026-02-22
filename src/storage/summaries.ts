import type { DB } from './db'
import { eq, inArray } from 'drizzle-orm'
import * as schema from './schema'

const GROUP_SUMMARY_ID = 'singleton'

export function getUserSummary(
  db: DB,
  userId: string,
): string | null {
  const row = db
    .select({ summary: schema.userSummaries.summary })
    .from(schema.userSummaries)
    .where(eq(schema.userSummaries.userId, userId))
    .get()

  return row?.summary ?? null
}

export function upsertUserSummary(
  db: DB,
  userId: string,
  summary: string,
): void {
  db
    .insert(schema.userSummaries)
    .values({
      id: crypto.randomUUID(),
      userId,
      summary,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.userSummaries.userId],
      set: {
        summary,
        updatedAt: Date.now(),
      },
    })
    .run()
}

export function getGroupSummary(
  db: DB,
): string | null {
  const row = db
    .select({ summary: schema.groupSummaries.summary })
    .from(schema.groupSummaries)
    .where(eq(schema.groupSummaries.id, GROUP_SUMMARY_ID))
    .get()

  return row?.summary ?? null
}

export function upsertGroupSummary(
  db: DB,
  summary: string,
): void {
  db
    .insert(schema.groupSummaries)
    .values({
      id: GROUP_SUMMARY_ID,
      summary,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.groupSummaries.id],
      set: {
        summary,
        updatedAt: Date.now(),
      },
    })
    .run()
}

export function getUserSummariesForGroup(
  db: DB,
  userIds: string[],
): Map<string, string> {
  if (userIds.length === 0) {
    return new Map()
  }

  const rows = db
    .select()
    .from(schema.userSummaries)
    .where(inArray(schema.userSummaries.userId, userIds))
    .all()

  return new Map(rows.map(row => [row.userId, row.summary]))
}
