# 記憶架構：Per-Group SQLite

## 設計決策

### 核心原則

- **每個群組 = 獨立 agent 生命週期**：每個群組擁有自己的 SQLite 檔案，包含 messages、summaries、vectors
- **訊息無限期保留**：不刪除、不 GC、不 TTL
- **Chunk-based embedding**：訊息依 reply chain 分組後 embed（成本更低、語義更完整）
- **共用設定全靠 env/config**：不需要共用 DB，只有 SOUL（人格 prompt）跨群組共用

### 為什麼 Per-Group？

| 面向          | 單一共用 DB               | Per-Group DB           |
| ------------- | ------------------------- | ---------------------- |
| 隔離性        | 邏輯隔離（group_id 欄位） | 物理隔離（獨立檔案）   |
| 群組間影響    | 共用 WAL、共用 lock       | 完全獨立               |
| 單群組資料量  | 36.5M 則（100 群組合計）  | 36.5 萬則/年（單群組） |
| 向量儲存      | ~210 GB/年（合計）        | ~2.1 GB/年（單群組）   |
| 備份/刪除群組 | 需 SQL 過濾               | 直接複製/刪除檔案      |
| Schema 簡潔度 | 每張表都需 group_id       | 不需要 group_id        |

### 規模評估

- 每群組 1000 則/天 × 365 天 = **36.5 萬則/年** — SQLite 毫無壓力
- 每群組向量 36.5 萬 × 1536 dim × 4 bytes ≈ **2.1 GB/年** — 可接受
- 每群組 DB 檔案 ≈ **3-4 GB/年**（含訊息 + 摘要 + 向量）
- 100 群組 = 100 個獨立 DB 檔案，totaling ~300-400 GB/年

### Embedding 策略比較

|          | Per-message（舊）           | Chunk-based（採用）                    |
| -------- | --------------------------- | -------------------------------------- |
| API 成本 | $0.37/年/群組               | 更低（多則訊息合併為一個 chunk embed） |
| 資訊損失 | 無                          | 極低（reply chain 保留對話脈絡）       |
| 搜尋粒度 | 可找到特定訊息              | 可找到對話片段（reply chain 或連續訊息）|
| 向量數量 | 36.5 萬/年                  | 更少（多則訊息合併）                   |

## Schema

### messages

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  reply_to_external_id TEXT
);
CREATE INDEX messages_timestamp_idx ON messages(timestamp);
CREATE INDEX messages_external_id_idx ON messages(external_id);
```

- `id`：INTEGER PRIMARY KEY AUTOINCREMENT — SQLite 自動分配，同時作為 sqlite-vec 的 rowid（消除橋接表）
- `external_id`：平台訊息 ID（Discord snowflake / LINE message ID），bot 訊息為 null
- 不需要 `group_id`：per-group DB 本身就是隔離單位
- 不需要 `platform`：per-group DB 天然對應單一平台
- 不需要 `created_at`：`timestamp` 已涵蓋所有時間查詢需求
- `reply_to_external_id`：回覆目標的平台訊息 ID（Discord/LINE），用於 chunking 時追溯 reply chain

### chunks

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  start_timestamp INTEGER NOT NULL,
  end_timestamp INTEGER NOT NULL
);
CREATE INDEX chunks_end_timestamp_idx ON chunks(end_timestamp);
```

- `content`：chunk 的文字內容（多則訊息合併，格式 `{userId}: {content}`）
- `message_ids`：JSON 陣列，記錄此 chunk 包含的所有 message id
- `start_timestamp` / `end_timestamp`：chunk 的時間範圍
- `end_timestamp` 索引：供 `processNewChunks` 查詢「上次處理到哪裡」

### user_summaries

```sql
CREATE TABLE user_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id)
);
```

### group_summaries

```sql
CREATE TABLE group_summaries (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- Per-group DB 中只有一筆記錄，`id` 固定為 `'singleton'`
- `updated_at` 同時作為 Observer 的 watermark（計算「距上次壓縮以來的訊息數」）

### chunk_vectors（sqlite-vec 虛擬表）

```sql
CREATE VIRTUAL TABLE chunk_vectors USING vec0(
  embedding float[1536]
);
```

- rowid 直接使用 `chunks.id`（INTEGER PK），無需額外的橋接表
- 維度由 `EMBEDDING_DIMENSIONS` config 決定
- 由 `initChunkVectorTable()` 在 embedding 模組初始化時建立（非 `initSchema()`）

## DB 檔案結構

```
data/groups/
├── {groupId_1}.db     # 群組 1 的所有資料
├── {groupId_2}.db     # 群組 2 的所有資料
└── ...
```

### GroupDbManager

- `GroupDbManager` 管理所有群組 DB 連線，內部 `Map<string, GroupDb>` 快取
- `getOrCreate(groupId)` — lazy init，首次存取時建立 DB 並執行 schema init
- `closeAll()` — graceful shutdown 時關閉所有連線

### 向量搜尋流程

```
messages → buildChunks() → ChunkInput[]
saveChunk(db, chunk) → chunks.id (INTEGER PK) → 直接作為 sqlite-vec rowid
insertChunkVector(db, chunkId, embedding) → INSERT（手動冪等）
searchSimilarChunks(db, queryEmbedding, topK, threshold) → { chunkId, distance }[]
getChunkContents(db, chunkIds) → string[]（chunk 文字內容）
context.ts → <related_history> 區塊
```

## 資料遷移

從舊的單一共用 DB 遷移到 per-group DB：

```bash
bun run scripts/migrate-to-per-group.ts <舊-db-路徑> [目標目錄]

# 範例
bun run scripts/migrate-to-per-group.ts ./data/yamada.db ./data/groups/
```

- 自動按 `group_id` 拆分 messages、summaries 到各 per-group DB
- 向量索引不遷移，程式啟動後會自動為新訊息建立 embedding

## 風險評估

| 風險                                   | 嚴重度 | 緩解措施                                                        |
| -------------------------------------- | ------ | --------------------------------------------------------------- |
| sqlite-vec 不支援 per-DB 初始化        | 低     | 已確認 sqlite-vec 是 per-connection extension，每個 DB 獨立載入 |
| 大量 DB 檔案的 OS file descriptor 限制 | 低     | 100 個 DB = 100 fd，遠低於預設 ulimit                           |
| Schema 變更需遍歷所有 DB               | 低     | 程式化 init 用 IF NOT EXISTS / ALTER TABLE IF NOT EXISTS        |

## 附錄：Agent 框架記憶架構參考

研究了 Letta/MemGPT、Mem0、LangChain、CrewAI 的記憶架構後，關鍵發現：

- **所有框架都沒有訊息 GC 機制** — 它們假設單一 agent 場景
- **Letta** 最成熟：Core Memory（context 內）+ Recall Memory（全歷史）+ Archival Memory（向量）
- **Mem0** embed 萃取後的「事實」而非原始訊息（成本更高、有資訊損失）
- **我們的系統** 結合了 Letta 的分層概念（summaries = Core、messages = Recall、vectors = Archival），但用物理隔離取代 Letta 的邏輯隔離
