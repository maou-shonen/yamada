import type { StoredImage } from '../types'
import type { DB } from './db'
import { Buffer } from 'node:buffer'
import { and, eq, inArray } from 'drizzle-orm'
import * as schema from './schema'

/**
 * 儲存圖片並回傳新建立的 ID
 * createdAt 由此函數自動設定為 Date.now()
 */
export function saveImage(
  db: DB,
  groupId: string,
  data: {
    messageId: number
    mimeType: string
    width: number
    height: number
    thumbnail: Uint8Array
  },
): number {
  const result = db
    .insert(schema.images)
    .values({
      groupId,
      messageId: data.messageId,
      mimeType: data.mimeType,
      width: data.width,
      height: data.height,
      createdAt: Date.now(),
      thumbnail: Buffer.from(data.thumbnail),
    })
    .returning({ id: schema.images.id })
    .get()

  return result?.id ?? 0
}

/**
 * 根據圖片 ID 取得圖片記錄
 */
export function getImageById(db: DB, groupId: string, id: number): StoredImage | null {
  const row = db
    .select()
    .from(schema.images)
    .where(and(eq(schema.images.id, id), eq(schema.images.groupId, groupId)))
    .get()

  if (!row)
    return null

  return {
    id: row.id,
    groupId: row.groupId,
    messageId: row.messageId,
    description: row.description,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    thumbnail: new Uint8Array(row.thumbnail as Buffer),
  }
}

/**
 * 根據群組 ID 和訊息 ID 取得圖片記錄
 */
export function getImageByMessageId(
  db: DB,
  groupId: string,
  messageId: number,
): StoredImage | null {
  const row = db
    .select()
    .from(schema.images)
    .where(and(eq(schema.images.groupId, groupId), eq(schema.images.messageId, messageId)))
    .get()

  if (!row)
    return null

  return {
    id: row.id,
    groupId: row.groupId,
    messageId: row.messageId,
    description: row.description,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    thumbnail: new Uint8Array(row.thumbnail as Buffer),
  }
}

/**
 * 批次取得多個訊息的圖片，回傳 Map<messageId, StoredImage>
 */
export function getImagesForMessages(
  db: DB,
  groupId: string,
  messageIds: number[],
): Map<number, StoredImage> {
  if (messageIds.length === 0)
    return new Map()

  const rows = db
    .select()
    .from(schema.images)
    .where(and(eq(schema.images.groupId, groupId), inArray(schema.images.messageId, messageIds)))
    .all()

  const result = new Map<number, StoredImage>()
  for (const row of rows) {
    result.set(row.messageId, {
      id: row.id,
      groupId: row.groupId,
      messageId: row.messageId,
      description: row.description,
      mimeType: row.mimeType,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt,
      thumbnail: new Uint8Array(row.thumbnail as Buffer),
    })
  }

  return result
}

/**
 * 更新圖片的描述欄位
 */
export function updateImageDescription(db: DB, id: number, description: string): void {
  db.update(schema.images).set({ description }).where(eq(schema.images.id, id)).run()
}
