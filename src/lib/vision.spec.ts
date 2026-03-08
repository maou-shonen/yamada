import type { Config } from '../config/index.ts'
import type { VisionDeps } from './vision'

import { describe, expect, mock, test } from 'bun:test'

import { createTestConfig } from '../__tests__/helpers/config.ts'
import { analyzeImage, generateImageDescription } from './vision'

function fakeGenerateTextResult(text: string) {
  return {
    text,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    steps: [],
  }
}

function createFakeDeps(
  implementation: (() => Promise<ReturnType<typeof fakeGenerateTextResult>>) | undefined = undefined,
) {
  const createModelMock = mock((modelId: string, _config: Config) => ({ modelId }))
  const generateTextMock = mock(implementation ?? (async () => fakeGenerateTextResult('vision result')))

  const deps: VisionDeps = {
    createModel: createModelMock as unknown as VisionDeps['createModel'],
    generateText: generateTextMock as unknown as VisionDeps['generateText'],
  }

  return {
    deps,
    createModelMock,
    generateTextMock,
  }
}

describe('generateImageDescription', () => {
  test('回傳描述文字，並使用正確的 multimodal 訊息格式', async () => {
    const config = createTestConfig({ VISION_MODEL: 'openai/gpt-4o' })
    const imageBuffer = Buffer.from('fake-image-buffer')
    const { deps, createModelMock, generateTextMock } = createFakeDeps(async () => fakeGenerateTextResult('一隻貓坐在窗邊，看著外面的街景。'))

    const result = await generateImageDescription(imageBuffer, config, deps)

    expect(result).toBe('一隻貓坐在窗邊，看著外面的街景。')
    expect(createModelMock).toHaveBeenCalledWith('openai/gpt-4o', config)
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: 'openai/gpt-4o' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image concisely in 1-2 sentences. Focus on the key visual elements.' },
          { type: 'image', image: imageBuffer },
        ],
      }],
    })
  })

  test('第一個 vision 模型失敗時會 fallback 到下一個模型', async () => {
    const config = createTestConfig({ VISION_MODEL: 'openai/model-a,openai/model-b' })
    const imageBuffer = Buffer.from('fake-image-buffer')

    let callCount = 0
    const { deps, createModelMock } = createFakeDeps(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('model-a failed')
      }
      return fakeGenerateTextResult('fallback description')
    })

    const result = await generateImageDescription(imageBuffer, config, deps)

    expect(result).toBe('fallback description')
    expect(createModelMock).toHaveBeenCalledTimes(2)
    expect(createModelMock.mock.calls[0]).toEqual(['openai/model-a', config])
    expect(createModelMock.mock.calls[1]).toEqual(['openai/model-b', config])
  })
})

describe('analyzeImage', () => {
  test('使用傳入問題作為分析 prompt', async () => {
    const config = createTestConfig({ VISION_MODEL: 'openai/gpt-4o' })
    const imageBuffer = Buffer.from('fake-image-buffer')
    const { deps, generateTextMock } = createFakeDeps(async () => fakeGenerateTextResult('這張圖顯示一個繁忙的夜市場景，主要焦點在中央攤位。'))

    const result = await analyzeImage(imageBuffer, '這張圖的主要焦點是什麼？', config, deps)

    expect(result).toBe('這張圖顯示一個繁忙的夜市場景，主要焦點在中央攤位。')
    const callArgs = generateTextMock.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(callArgs[0].messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '這張圖的主要焦點是什麼？' },
        { type: 'image', image: imageBuffer },
      ],
    }])
  })

  test('問題為空白時使用預設分析 prompt', async () => {
    const config = createTestConfig({ VISION_MODEL: 'openai/gpt-4o' })
    const imageBuffer = Buffer.from('fake-image-buffer')
    const { deps, generateTextMock } = createFakeDeps(async () => fakeGenerateTextResult('這是一張室內空間照片，包含桌椅與自然採光。'))

    await analyzeImage(imageBuffer, '   ', config, deps)

    const callArgs = generateTextMock.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(callArgs[0].messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this image in detail. Focus on the key visual elements, context, and anything notable.' },
        { type: 'image', image: imageBuffer },
      ],
    }])
  })

  test('所有 vision 模型都失敗時拋出最後一個錯誤', async () => {
    const config = createTestConfig({ VISION_MODEL: 'openai/model-a,openai/model-b' })
    const imageBuffer = Buffer.from('fake-image-buffer')

    let callCount = 0
    const { deps } = createFakeDeps(async () => {
      callCount++
      throw new Error(`model-${callCount} failed`)
    })

    try {
      await analyzeImage(imageBuffer, '請詳細分析', config, deps)
      throw new Error('Expected analyzeImage to throw when all models fail')
    }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('model-2 failed')
    }
  })
})
