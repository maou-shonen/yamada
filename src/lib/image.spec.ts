import { afterEach, describe, expect, mock, test } from 'bun:test'
import sharp from 'sharp'
import { downloadImage, resizeImage } from './image'

const originalFetch = globalThis.fetch

async function createPngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer()
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('resizeImage', () => {
  test('preserves aspect ratio when resizing', async () => {
    const input = await createPngBuffer(1000, 500)

    const result = await resizeImage(input, 256, 65)

    expect(result.width).toBe(256)
    expect(result.height).toBe(128)
  })

  test('converts resized output to webp', async () => {
    const input = await createPngBuffer(320, 160)

    const result = await resizeImage(input, 256, 65)
    const metadata = await sharp(result.buffer).metadata()

    expect(result.mimeType).toBe('image/webp')
    expect(metadata.format).toBe('webp')
    expect(metadata.width).toBe(result.width)
    expect(metadata.height).toBe(result.height)
  })
})

describe('downloadImage', () => {
  test('rejects oversized downloads from content-length header', async () => {
    const testBuffer = Buffer.from('tiny image')
    const mockFetch = mock(() => Promise.resolve(new Response(testBuffer, {
      status: 200,
      headers: { 'content-length': String(2 * 1024 * 1024) },
    })))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      await downloadImage('https://example.com/image.png', 1)
      throw new Error('Expected downloadImage to reject oversized downloads')
    }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Image too large: 2097152 bytes exceeds 1MB limit')
    }

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
