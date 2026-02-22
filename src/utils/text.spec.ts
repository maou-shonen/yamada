import { expect, test, describe } from 'bun:test'
import { containsUrl, truncateText, isEmbeddableContent, estimateTokens } from './index'

describe('containsUrl', () => {

  test('應該偵測 https URL', () => {
    expect(containsUrl('https://example.com')).toBe(true)
  })

  test('應該偵測 http URL', () => {
    expect(containsUrl('http://example.com/path?q=1')).toBe(true)
  })

  test('應該偵測文字中的 URL', () => {
    expect(containsUrl('看這個 https://example.com 很讚')).toBe(true)
  })


  test('純文字訊息應該回傳 false', () => {
    expect(containsUrl('純文字訊息')).toBe(false)
  })

  test('貼圖佔位符應該回傳 false', () => {
    expect(containsUrl('[貼圖]')).toBe(false)
  })

  test('空字串應該回傳 false', () => {
    expect(containsUrl('')).toBe(false)
  })


  test('www.example.com（無 protocol）應該回傳 false', () => {
    expect(containsUrl('www.example.com')).toBe(false)
  })

  test('ftp URL 應該回傳 false', () => {
    expect(containsUrl('ftp://example.com')).toBe(false)
  })

  test('多個 URL 應該回傳 true', () => {
    expect(containsUrl('https://a.com 和 https://b.com')).toBe(true)
  })

  test('URL 後面有標點符號應該回傳 true', () => {
    expect(containsUrl('看看 https://example.com。')).toBe(true)
  })
})
