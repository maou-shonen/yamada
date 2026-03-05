import { describe, expect, test } from 'bun:test'
import { createUserMask, replaceAliasesWithNames, replaceUserIdsWithAliases, sanitizeDiscordMentions } from './alias-replacer'

describe('replaceUserIdsWithAliases', () => {
  test('替換單個 userId 前綴', () => {
    const map = new Map([['U123', 'user_bright_owl']])
    const result = replaceUserIdsWithAliases('U123: hello', map)
    expect(result).toBe('user_bright_owl: hello')
  })

  test('替換多個 userId', () => {
    const map = new Map([['U123', 'user_bright_owl'], ['U456', 'user_swift_hawk']])
    const result = replaceUserIdsWithAliases('U123: hello\nU456: hi\nU123: bye', map)
    expect(result).toBe('user_bright_owl: hello\nuser_swift_hawk: hi\nuser_bright_owl: bye')
  })

  test('未知 userId 保持原樣', () => {
    const map = new Map([['U123', 'user_bright_owl']])
    const result = replaceUserIdsWithAliases('U999: unknown', map)
    expect(result).toBe('U999: unknown')
  })

  test('空 map 回傳原文', () => {
    const result = replaceUserIdsWithAliases('U123: hello', new Map())
    expect(result).toBe('U123: hello')
  })
})

describe('replaceAliasesWithNames', () => {
  test('替換 alias 為 userName', () => {
    const map = new Map([['user_bright_owl', 'Alice']])
    const result = replaceAliasesWithNames('user_bright_owl 說了什麼', map)
    expect(result).toBe('Alice 說了什麼')
  })

  test('串接替換防護', () => {
    // user_bright_owl → user_swift_hawk_fan，user_swift_hawk → Bob
    // 不應該把 user_swift_hawk_fan 中的 user_swift_hawk 再替換為 Bob
    const map = new Map([['user_bright_owl', 'user_swift_hawk_fan'], ['user_swift_hawk', 'Bob']])
    const result = replaceAliasesWithNames('user_bright_owl said hi to user_swift_hawk', map)
    expect(result).toBe('user_swift_hawk_fan said hi to Bob')
  })

  test('空 map 回傳原文', () => {
    const result = replaceAliasesWithNames('user_bright_owl: hello', new Map())
    expect(result).toBe('user_bright_owl: hello')
  })
})

describe('sanitizeDiscordMentions', () => {
  test('替換 <@userId> 為 alias', () => {
    const map = new Map([['123456789', 'user_bright_owl']])
    const result = sanitizeDiscordMentions('hello <@123456789>', map)
    expect(result).toBe('hello user_bright_owl')
  })

  test('替換 <@!userId> 為 alias', () => {
    const map = new Map([['123456789', 'user_bright_owl']])
    const result = sanitizeDiscordMentions('hello <@!123456789>', map)
    expect(result).toBe('hello user_bright_owl')
  })

  test('未知 userId 的 mention 移除', () => {
    const result = sanitizeDiscordMentions('hello <@999>', new Map())
    expect(result).toBe('hello ')
  })
})

describe('UserMask', () => {
  test('mask：已知 userId 轉 alias；未知 userId 回傳原值', () => {
    const mask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))

    expect(mask.mask('discord:123')).toBe('user_bright_owl')
    expect(mask.mask('discord:999')).toBe('discord:999')
  })

  test('unmask：已知 alias 轉 userId；未知 alias 回傳原值', () => {
    const mask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))

    expect(mask.unmask('user_bright_owl')).toBe('discord:123')
    expect(mask.unmask('user_calm_fox')).toBe('user_calm_fox')
  })

  test('mask + unmask roundtrip：可回復原始 userId', () => {
    const mask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))

    expect(mask.unmask(mask.mask('discord:123'))).toBe('discord:123')
  })

  test('空 aliasMap：雙向皆回傳原值', () => {
    const mask = createUserMask(new Map())

    expect(mask.mask('discord:123')).toBe('discord:123')
    expect(mask.unmask('user_bright_owl')).toBe('user_bright_owl')
  })
})
