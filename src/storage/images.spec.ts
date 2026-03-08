import { expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import {
  getImageById,
  getImageByMessageId,
  getImagesForMessages,
  saveImage,
  updateImageDescription,
} from './images'

function makeDb() {
  return setupTestDb()
}

function createTestThumbnail(size: number = 100): Uint8Array {
  return new Uint8Array(size)
}

test('saveImage - 儲存圖片並回傳 ID', () => {
  const { db } = makeDb()

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  expect(id).toBeGreaterThan(0)
})

test('getImageById - 根據 ID 取得圖片', () => {
  const { db } = makeDb()
  const thumbnail = createTestThumbnail(50)

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail,
  })

  const image = getImageById(db, id)
  expect(image).not.toBeNull()
  expect(image?.id).toBe(id)
  expect(image?.groupId).toBe('group-a')
  expect(image?.messageId).toBe(1)
  expect(image?.mimeType).toBe('image/webp')
  expect(image?.width).toBe(256)
  expect(image?.height).toBe(256)
  expect(image?.description).toBeNull()
  expect(image?.thumbnail).toEqual(thumbnail)
  expect(image?.createdAt).toBeGreaterThan(0)
})

test('getImageById - 不存在的 ID 回傳 null', () => {
  const { db } = makeDb()

  const image = getImageById(db, 9999)
  expect(image).toBeNull()
})

test('getImageByMessageId - 根據群組和訊息 ID 取得圖片', () => {
  const { db } = makeDb()
  const thumbnail = createTestThumbnail(75)

  saveImage(db, 'group-a', {
    messageId: 10,
    mimeType: 'image/jpeg',
    width: 512,
    height: 512,
    thumbnail,
  })

  const image = getImageByMessageId(db, 'group-a', 10)
  expect(image).not.toBeNull()
  expect(image?.messageId).toBe(10)
  expect(image?.groupId).toBe('group-a')
  expect(image?.mimeType).toBe('image/jpeg')
  expect(image?.width).toBe(512)
  expect(image?.height).toBe(512)
})

test('getImageByMessageId - 不同群組的訊息不可見', () => {
  const { db } = makeDb()

  saveImage(db, 'group-a', {
    messageId: 10,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  const image = getImageByMessageId(db, 'group-b', 10)
  expect(image).toBeNull()
})

test('getImageByMessageId - 不存在的訊息 ID 回傳 null', () => {
  const { db } = makeDb()

  const image = getImageByMessageId(db, 'group-a', 9999)
  expect(image).toBeNull()
})

test('getImagesForMessages - 批次取得多個訊息的圖片', () => {
  const { db } = makeDb()

  // 儲存 3 個圖片
  saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  saveImage(db, 'group-a', {
    messageId: 2,
    mimeType: 'image/jpeg',
    width: 512,
    height: 512,
    thumbnail: createTestThumbnail(75),
  })

  saveImage(db, 'group-a', {
    messageId: 3,
    mimeType: 'image/png',
    width: 128,
    height: 128,
    thumbnail: createTestThumbnail(25),
  })

  const images = getImagesForMessages(db, 'group-a', [1, 2, 3])
  expect(images.size).toBe(3)
  expect(images.get(1)?.mimeType).toBe('image/webp')
  expect(images.get(2)?.mimeType).toBe('image/jpeg')
  expect(images.get(3)?.mimeType).toBe('image/png')
})

test('getImagesForMessages - 部分訊息有圖片', () => {
  const { db } = makeDb()

  saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  // 訊息 2 和 3 沒有圖片
  const images = getImagesForMessages(db, 'group-a', [1, 2, 3])
  expect(images.size).toBe(1)
  expect(images.has(1)).toBe(true)
  expect(images.has(2)).toBe(false)
  expect(images.has(3)).toBe(false)
})

test('getImagesForMessages - 空陣列回傳空 Map', () => {
  const { db } = makeDb()

  const images = getImagesForMessages(db, 'group-a', [])
  expect(images.size).toBe(0)
})

test('getImagesForMessages - 不同群組的圖片不混合', () => {
  const { db } = makeDb()

  saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  saveImage(db, 'group-b', {
    messageId: 1,
    mimeType: 'image/jpeg',
    width: 512,
    height: 512,
    thumbnail: createTestThumbnail(75),
  })

  const imagesA = getImagesForMessages(db, 'group-a', [1])
  const imagesB = getImagesForMessages(db, 'group-b', [1])

  expect(imagesA.size).toBe(1)
  expect(imagesB.size).toBe(1)
  expect(imagesA.get(1)?.mimeType).toBe('image/webp')
  expect(imagesB.get(1)?.mimeType).toBe('image/jpeg')
})

test('updateImageDescription - 更新圖片描述', () => {
  const { db } = makeDb()

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  // 初始描述為 null
  let image = getImageById(db, id)
  expect(image?.description).toBeNull()

  // 更新描述
  updateImageDescription(db, id, 'A beautiful sunset')

  image = getImageById(db, id)
  expect(image?.description).toBe('A beautiful sunset')
})

test('updateImageDescription - 更新已有描述的圖片', () => {
  const { db } = makeDb()

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  updateImageDescription(db, id, 'First description')
  let image = getImageById(db, id)
  expect(image?.description).toBe('First description')

  // 更新為新描述
  updateImageDescription(db, id, 'Updated description')
  image = getImageById(db, id)
  expect(image?.description).toBe('Updated description')
})

test('updateImageDescription - 更新不存在的圖片（靜默忽略）', () => {
  const { db } = makeDb()

  // 不應拋出錯誤
  updateImageDescription(db, 9999, 'Some description')
})

test('thumbnail 精度 - Uint8Array 往返', () => {
  const { db } = makeDb()

  // 建立一個特定的 Uint8Array
  const originalThumbnail = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253])

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: originalThumbnail,
  })

  const image = getImageById(db, id)
  expect(image?.thumbnail).toEqual(originalThumbnail)
})

test('createdAt 自動設定 - 時間戳精度', () => {
  const { db } = makeDb()
  const beforeSave = Date.now()

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  const afterSave = Date.now()
  const image = getImageById(db, id)

  expect(image?.createdAt).toBeGreaterThanOrEqual(beforeSave)
  expect(image?.createdAt).toBeLessThanOrEqual(afterSave)
})

test('混合操作 - 儲存、查詢、更新', () => {
  const { db } = makeDb()

  // 儲存 2 個圖片
  const id1 = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  const id2 = saveImage(db, 'group-a', {
    messageId: 2,
    mimeType: 'image/jpeg',
    width: 512,
    height: 512,
    thumbnail: createTestThumbnail(75),
  })

  // 批次查詢
  const images = getImagesForMessages(db, 'group-a', [1, 2])
  expect(images.size).toBe(2)

  // 更新第一個圖片的描述
  updateImageDescription(db, id1, 'First image')

  // 驗證更新
  const updated = getImageById(db, id1)
  expect(updated?.description).toBe('First image')

  // 驗證第二個圖片未受影響
  const unchanged = getImageById(db, id2)
  expect(unchanged?.description).toBeNull()
})

test('mimeType 預設值 - image/webp', () => {
  const { db } = makeDb()

  const id = saveImage(db, 'group-a', {
    messageId: 1,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  const image = getImageById(db, id)
  expect(image?.mimeType).toBe('image/webp')
})

test('多個群組隔離 - 訊息 ID 相同但群組不同', () => {
  const { db } = makeDb()

  const id1 = saveImage(db, 'group-a', {
    messageId: 100,
    mimeType: 'image/webp',
    width: 256,
    height: 256,
    thumbnail: createTestThumbnail(50),
  })

  const id2 = saveImage(db, 'group-b', {
    messageId: 100,
    mimeType: 'image/jpeg',
    width: 512,
    height: 512,
    thumbnail: createTestThumbnail(75),
  })

  const imageA = getImageByMessageId(db, 'group-a', 100)
  const imageB = getImageByMessageId(db, 'group-b', 100)

  expect(imageA?.id).toBe(id1)
  expect(imageB?.id).toBe(id2)
  expect(imageA?.mimeType).toBe('image/webp')
  expect(imageB?.mimeType).toBe('image/jpeg')
})
