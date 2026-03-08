# AGENTS.md

## 目標

多平台（Discord + LINE）AI 群組聊天機器人——像真人成員參與對話，不是助手。核心機制：debounce 批次回覆、長期記憶壓縮、語義搜尋、per-group 隔離。

## 架構

- **Single unified SQLite**：所有群組資料存於同一 DB 檔案（`data/yamada.db`），以 `group_id` 欄位邏輯隔離
- **Schema 初始化**：程式化 `CREATE TABLE IF NOT EXISTS`，不使用 Drizzle migration 檔案
- **AppDb**：`AppDb = { db: DB, sqlite: Database }`，由 `openDb(dbPath, dimensions)` 建立
- 架構文件詳見 `docs/memory.md`

## 訊息處理流程

### Discord 入口（`src/discord/channel.ts`）

WebSocket 長連線，監聽 MessageCreate 事件。

1. 過濾：`author.bot` → 丟棄；無 `guild`（DM）→ 丟棄
2. 判定 `groupId`：guild mode → `guild.id` / channel mode → `channel.id`
3. 解析 `content`：文字 / 附件 → `[圖片]` / 貼圖 → `[sticker]`；皆無則丟棄
4. 判定 `isMention`：`message.mentions.users.has(bot)` || `@everyone`
5. 組裝 `UnifiedMessage` → `onMessage()`

### LINE 入口（`src/line/channel.ts`）

HTTP Webhook（`Bun.serve`），接收 `POST /webhook/line`。

1. 驗證 `x-line-signature`；失敗 → 401
2. 過濾：`source.type === 'user'`（DM）→ 回覆「不支援私訊」；非 `group` → 丟棄
3. `pool.store(groupId, replyToken)` 存放 token 供回覆時使用
4. 解析 `userName`（`getGroupMemberProfile` API，fallback 到 userId）
5. 解析 `content`：文字 / 貼圖 / 圖片 / 影片 / 音訊 / 檔案 / 位置
6. 判定 `isMention`：`mentionees` 含 bot userId
7. 組裝 `UnifiedMessage` → `onMessage()`

### 共用流程（`src/bootstrap.ts` → `src/agent/index.ts`）

兩平台匯合後走同一條路：

1. `handleMessage()` 路由到 per-group Agent（lazy 建立）
2. `Agent.receiveMessage()`：儲存訊息到 DB（帶 `group_id`）+ 記錄用戶活動統計（`user_stats`）
3. `upsertTrigger()`：寫入 `main.db` 的 `pending_triggers`（`isMention` sticky flag：同批次曾 mention 就保持）
4. Scheduler 輪詢 `pending_triggers` → 靜默逾時 / 字元溢出 / @mention 條件成立時 claim
5. 頻率控制器 `checkFrequency()`：
   - `@mention` 或 `FREQUENCY_ENABLED=false` → 無條件通過
   - 否則基於 bot 發言佔比（EMA）vs 公平份額 `1/(活躍人數+1)` 計算 sigmoid 機率
   - 拒絕 → 跳過整個 AI pipeline（節省 LLM tokens）
6. Context 組裝：SOUL 人格 + 群組摘要 + 用戶摘要 + 語義搜尋 + 近期訊息
7. LLM 生成（Vercel AI SDK）→ 回傳 `reply` / `reaction` / `skip`
8. 投遞回覆 + 儲存 bot 訊息 + 更新 EMA 狀態（僅 reply 時）
9. 背景任務（fire-and-forget）：Observer 壓縮記憶 + Embedding 建立向量索引

### 平台差異摘要

|              | Discord                                            | LINE                                                    |
| ------------ | -------------------------------------------------- | ------------------------------------------------------- |
| 連線方式     | WebSocket Gateway（長連線）                        | Webhook HTTP server（`Bun.serve`）                      |
| groupId      | guild mode: server id / channel mode: channel id   | `event.source.groupId`                                  |
| mention 判定 | `message.mentions.users.has(bot)` \|\| `@everyone` | `mentionees` 含 bot userId                              |
| 回覆機制     | `channel.send()`                                   | replyToken 優先（免費）→ fallback pushMessage（有配額） |
| reaction     | 原生 emoji reaction                                | 不支援（靜默忽略）                                      |
| DM 處理      | 靜默丟棄                                           | 回覆「不支援私訊」後丟棄                                |
| 內容類型     | 文字 / 附件 / 貼圖                                 | 文字 / 貼圖 / 圖片 / 影片 / 音訊 / 檔案 / 位置          |

## 指令

本專案使用 [mise](https://mise.jdx.dev/) 管理工具版本與執行腳本（見 `mise.toml`）。

```bash
mise run dev               # 啟動開發伺服器（自動偵測已設定的平台）
mise run fix               # ESLint 自動修復 + 格式化
mise run typecheck         # tsc --noEmit
mise run check             # lint + typecheck 並行
mise run test              # 全部測試（單元 + 整合 + E2E）
mise run ci                # 完整 CI 流程（check + test）
```

- Runtime: **Bun**（由 mise 管理版本，見 `mise.toml` 的 `[tools]`）
- AI: Vercel AI SDK + OpenAI-compatible
- DB: Drizzle ORM + SQLite（`bun:sqlite`）、sqlite-vec 向量搜尋
- 平台: discord.js、@line/bot-sdk
- Config 由 `src/config/index.ts` 的 Zod schema 驗證，屬性名 = env var 名（`SCREAMING_SNAKE_CASE`）。完整清單見 @README.md。

## 測試

- 所有模組皆透過 DI deps 參數注入依賴，測試時傳入 fake——不使用全域 mock
