import sharp from 'sharp'
import { log } from '../logger'

const imageLog = log.withPrefix('[Image]')

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export async function downloadImage(url: string, maxSizeMB: number): Promise<Buffer> {
  const maxBytes = maxSizeMB * 1024 * 1024

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok)
      throw new Error(`Download failed: ${response.status} ${response.statusText}`)

    const contentLengthHeader = response.headers.get('content-length')
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader)
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`Image too large: ${contentLength} bytes exceeds ${maxSizeMB}MB limit`)
      }
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Downloaded image too large: ${arrayBuffer.byteLength} bytes exceeds ${maxSizeMB}MB limit`)
    }

    return Buffer.from(arrayBuffer)
  }
  catch (error) {
    imageLog.withError(toError(error)).warn('Image download failed')
    throw error
  }
}

export async function resizeImage(
  buffer: Buffer,
  maxDimension: number,
  quality: number,
): Promise<{
  buffer: Buffer
  width: number
  height: number
  mimeType: string
}> {
  try {
    const resized = await sharp(buffer)
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true })

    if (resized.info.width === undefined || resized.info.height === undefined)
      throw new Error('Resized image dimensions unavailable')

    return {
      buffer: resized.data,
      width: resized.info.width,
      height: resized.info.height,
      mimeType: 'image/webp',
    }
  }
  catch (error) {
    imageLog.withError(toError(error)).warn('Image resize failed')
    throw error
  }
}
