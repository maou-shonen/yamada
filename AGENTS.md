# AGENTS.md

## 目標

多平台（Discord + LINE）AI 群組聊天機器人——像真人成員參與對話，不是助手。核心機制：debounce 批次回覆、長期記憶壓縮、語義搜尋、per-group 隔離。

## 架構

- **Per-group SQLite**：每個群組一個獨立 DB 檔案（`data/groups/{groupId}.db`），包含 messages、summaries、vectors
- **GroupDbManager**：管理所有群組 DB 連線，lazy init + 快取
- **Schema 初始化**：程式化 `CREATE TABLE IF NOT EXISTS`，不使用 Drizzle migration 檔案
- 架構文件詳見 `docs/memory.md`

## 指令

```bash
bun run dev              # 啟動雙平台（Discord + LINE）
bun run dev:discord      # 僅 Discord
bun run dev:line         # 僅 LINE
bun run lint:fix         # ESLint 自動修復 + 格式化
bun run typecheck        # tsc --noEmit
bun test                 # 全部測試（單元 + 整合 + E2E）
```

- Runtime: **Bun**（不是 Node.js，用 `bun test`、`bun run`）
- AI: Vercel AI SDK + OpenAI-compatible
- DB: Drizzle ORM + SQLite（`bun:sqlite`）、sqlite-vec 向量搜尋
- 平台: discord.js、@line/bot-sdk
- Config 由 `src/config/index.ts` 的 Zod schema 驗證，屬性名 = env var 名（`SCREAMING_SNAKE_CASE`）。完整清單見 @README.md。

## 測試

- 所有模組皆透過 DI deps 參數注入依賴，測試時傳入 fake——不使用全域 mock
