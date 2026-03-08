import { describe, expect, it } from 'bun:test'
import { logAiRequest, sanitizeMessagesForLog } from './ai-logger'

describe('sanitizeMessagesForLog', () => {
  it('replaces Buffer with metadata', () => {
    const buf = Buffer.alloc(1024)
    const messages = [
      { role: 'user', content: [{ type: 'image', image: buf }] },
    ]
    const result = sanitizeMessagesForLog(messages)

    expect(result).toHaveLength(1)
    const resultItem = result[0] as any
    expect(resultItem).toEqual({
      role: 'user',
      content: [{ type: 'image', image: { type: 'image-binary', byteLength: 1024 } }],
    })
    // Ensure it's not a Buffer
    expect(Buffer.isBuffer(resultItem.content[0].image)).toBe(false)
  })

  it('preserves non-Buffer content', () => {
    const messages = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi there' },
    ]
    const result = sanitizeMessagesForLog(messages)

    expect(result).toEqual(messages)
  })

  it('handles nested Buffer in array', () => {
    const buf = Buffer.alloc(512)
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', image: buf },
        ],
      },
    ]
    const result = sanitizeMessagesForLog(messages)

    expect(result).toHaveLength(1)
    const resultItem = result[0] as any
    expect(resultItem.content).toHaveLength(2)
    expect(resultItem.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(resultItem.content[1]).toEqual({
      type: 'image',
      image: { type: 'image-binary', byteLength: 512 },
    })
  })

  it('handles deeply nested objects with Buffer', () => {
    const buf = Buffer.alloc(256)
    const messages = [
      {
        role: 'user',
        data: {
          nested: {
            image: buf,
            text: 'test',
          },
        },
      },
    ]
    const result = sanitizeMessagesForLog(messages)

    const resultItem = result[0] as any
    expect(resultItem.data.nested.image).toEqual({
      type: 'image-binary',
      byteLength: 256,
    })
    expect(resultItem.data.nested.text).toBe('test')
  })

  it('handles empty array', () => {
    const messages: unknown[] = []
    const result = sanitizeMessagesForLog(messages)

    expect(result).toEqual([])
  })
})

describe('logAiRequest', () => {
  it('does not throw with minimal entry', () => {
    const calls: Array<{ metadata: unknown; message: string }> = []
    const fakeLogger = {
      withMetadata: (meta: unknown) => ({
        info: (msg: string) => {
          calls.push({ metadata: meta, message: msg })
        },
      }),
    } as any

    expect(() =>
      logAiRequest(
        {
          callType: 'chat',
          groupId: 'test-group',
          model: 'test/model',
          durationMs: 100,
          input: { messages: [] },
          output: { actions: [] },
        },
        fakeLogger,
      ),
    ).not.toThrow()

    expect(calls).toHaveLength(1)
    expect(calls[0].message).toContain('chat')
    expect(calls[0].message).toContain('completed')
  })

  it('handles entry without usage', () => {
    const calls: string[] = []
    const fakeLogger = {
      withMetadata: () => ({
        info: (msg: string) => {
          calls.push(msg)
        },
      }),
    } as any

    expect(() =>
      logAiRequest(
        {
          callType: 'observer-group',
          groupId: 'g1',
          model: 'test/model',
          durationMs: 50,
          input: 'some prompt',
          output: 'some summary',
          // usage omitted
        },
        fakeLogger,
      ),
    ).not.toThrow()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('observer-group')
    expect(calls[0]).toContain('completed')
  })

  it('shows "failed" in message when error present', () => {
    const calls: string[] = []
    const fakeLogger = {
      withMetadata: () => ({
        info: (msg: string) => {
          calls.push(msg)
        },
      }),
    } as any

    logAiRequest(
      {
        callType: 'vision',
        groupId: 'g1',
        model: 'test/model',
        durationMs: 10,
        input: { prompt: 'test', imageByteLength: 1024 },
        output: null,
        error: new Error('API error'),
      },
      fakeLogger,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('failed')
  })

  it('passes entry as metadata to logger', () => {
    const metadataCapture: unknown[] = []
    const fakeLogger = {
      withMetadata: (meta: unknown) => {
        metadataCapture.push(meta)
        return {
          info: () => {},
        }
      },
    } as any

    const entry = {
      callType: 'chat' as const,
      groupId: 'g1',
      model: 'test/model',
      durationMs: 100,
      input: { messages: [] },
      output: { actions: [] },
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    }

    logAiRequest(entry, fakeLogger)

    expect(metadataCapture).toHaveLength(1)
    expect(metadataCapture[0]).toEqual(entry)
  })

  it('handles all callType variants', () => {
    const callTypes: Array<'chat' | 'observer-group' | 'observer-user' | 'fact-extraction' | 'vision'> = [
      'chat',
      'observer-group',
      'observer-user',
      'fact-extraction',
      'vision',
    ]

    for (const callType of callTypes) {
      const calls: string[] = []
      const fakeLogger = {
        withMetadata: () => ({
          info: (msg: string) => {
            calls.push(msg)
          },
        }),
      } as any

      logAiRequest(
        {
          callType,
          groupId: 'g1',
          model: 'test/model',
          durationMs: 50,
          input: 'test',
          output: 'result',
        },
        fakeLogger,
      )

      expect(calls[0]).toContain(callType)
    }
  })

  it('includes attempt info when provided', () => {
    const metadataCapture: unknown[] = []
    const fakeLogger = {
      withMetadata: (meta: unknown) => {
        metadataCapture.push(meta)
        return {
          info: () => {},
        }
      },
    } as any

    logAiRequest(
      {
        callType: 'chat',
        groupId: 'g1',
        model: 'test/model',
        durationMs: 100,
        input: 'test',
        output: 'result',
        attempt: 2,
        totalAttempts: 3,
      },
      fakeLogger,
    )

    expect(metadataCapture[0]).toEqual(
      expect.objectContaining({
        attempt: 2,
        totalAttempts: 3,
      }),
    )
  })
})
