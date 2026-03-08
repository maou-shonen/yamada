import { LogFileRotationTransport } from '@loglayer/transport-log-file-rotation'
import { getSimplePrettyTerminal } from '@loglayer/transport-simple-pretty-terminal'
import { LogLayer } from 'loglayer'
import { serializeError } from 'serialize-error'

/** Logging 設定（對應 Config.logging） */
export interface LoggingConfig {
  dir: string
  rotationFrequency: string
  maxSize: string
  maxRetention: string
}

/** 預設 logging 設定（在 loadConfig 之前使用） */
const DEFAULT_LOGGING: LoggingConfig = {
  dir: './logs',
  rotationFrequency: 'daily',
  maxSize: '50M',
  maxRetention: '14d',
}

/** 建立 LogLayer 實例 */
export function createLogger(config: LoggingConfig = DEFAULT_LOGGING): LogLayer {
  return new LogLayer({
    errorSerializer: serializeError,
    transport: [
      // 終端輸出
      getSimplePrettyTerminal({
        runtime: 'node',
        viewMode: 'inline',
      }),
      // 輪替檔案日誌
      new LogFileRotationTransport({
        filename: `${config.dir}/app-%DATE%.log`,
        frequency: config.rotationFrequency,
        dateFormat: 'YMD',
        size: config.maxSize,
        maxLogs: config.maxRetention,
        compressOnRotate: true,
        auditFile: `${config.dir}/audit.json`,
      }),
    ],
  })
}

/**
 * 預設 logger 實例（使用預設設定）
 * 啟動後可透過 createLogger(config.logging) 建立使用自訂設定的實例
 */
export const log = createLogger()

/** 建立只有 file transport 的 AI 請求 logger（不含 terminal 輸出） */
export function createAiLogger(config: LoggingConfig = DEFAULT_LOGGING): LogLayer {
  return new LogLayer({
    errorSerializer: serializeError,
    transport: [
      new LogFileRotationTransport({
        filename: `${config.dir}/ai-%DATE%.log`,
        frequency: config.rotationFrequency,
        dateFormat: 'YMD',
        size: config.maxSize,
        maxLogs: config.maxRetention,
        compressOnRotate: true,
        auditFile: `${config.dir}/ai-audit.json`,
      }),
    ],
  })
}

export const aiLog = createAiLogger()
