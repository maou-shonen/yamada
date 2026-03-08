import type { StoredChunk } from '../types'
import type { DB } from './db'
import { and, eq, inArray, max } from 'drizzle-orm'
import * as schema from './schema'

/**
 * chunk를 DB에 저장하고 생성된 ID 반환
 */
export function saveChunk(
  db: DB,
  groupId: string,
  chunk: { content: string, messageIds: number[], startTimestamp: number, endTimestamp: number },
): number {
  const result = db
    .insert(schema.chunks)
    .values({
      groupId,
      content: chunk.content,
      messageIds: JSON.stringify(chunk.messageIds),
      startTimestamp: chunk.startTimestamp,
      endTimestamp: chunk.endTimestamp,
    })
    .returning({ id: schema.chunks.id })
    .get()
  return result!.id
}

/**
 * ID로 chunk 조회 (없으면 null)
 * messageIds는 TEXT → number[] 자동 변환
 */
export function getChunkById(db: DB, groupId: string, chunkId: number): StoredChunk | null {
  const row = db
    .select()
    .from(schema.chunks)
    .where(and(eq(schema.chunks.groupId, groupId), eq(schema.chunks.id, chunkId)))
    .get()
  if (!row)
    return null
  return { ...row, messageIds: JSON.parse(row.messageIds) as number[] }
}

/**
 * 특정 message ID들을 포함하는 chunks 조회
 * V1 구현: groupId로 필터 후 애플리케이션 레벨에서 message ID 필터
 */
export function getChunksByMessageIds(db: DB, groupId: string, messageIds: number[]): StoredChunk[] {
  const rows = db
    .select()
    .from(schema.chunks)
    .where(eq(schema.chunks.groupId, groupId))
    .all()
  return rows
    .map(row => ({ ...row, messageIds: JSON.parse(row.messageIds) as number[] }))
    .filter(chunk => chunk.messageIds.some(id => messageIds.includes(id)))
}

/**
 * chunks 테이블에서 최대 end_timestamp 반환 (없으면 null)
 */
export function getMaxChunkEndTimestamp(db: DB, groupId: string): number | null {
  const result = db
    .select({ maxTs: max(schema.chunks.endTimestamp) })
    .from(schema.chunks)
    .where(eq(schema.chunks.groupId, groupId))
    .get()
  return result?.maxTs ?? null
}

/**
 * chunk ID 목록으로 content 문자열 배열 반환
 * 입력한 ID 순서를 유지하며, 존재하지 않는 ID는 제외
 */
export function getChunkContents(db: DB, groupId: string, chunkIds: number[]): string[] {
  if (chunkIds.length === 0)
    return []
  const rows = db
    .select({ id: schema.chunks.id, content: schema.chunks.content })
    .from(schema.chunks)
    .where(and(eq(schema.chunks.groupId, groupId), inArray(schema.chunks.id, chunkIds)))
    .all()
  // ID 순서에 맞게 정렬
  const contentMap = new Map(rows.map(r => [r.id, r.content]))
  return chunkIds.map(id => contentMap.get(id) ?? '').filter(Boolean)
}
