# 記憶架構：Unified SQLite

## 設計決策

### 核心原則

- **Single unified DB**：所有群組資料存於同一 SQLite 檔案，以 `group_id` 欄位邏輯隔離
- **訊息無限期保留**：不刪除、不 GC、不 TTL
- **Chunk-based embedding**：訊息依 reply chain 分組後 embed（成本更低、語義更完整）
- **共用設定全靠 env/config**：只有 SOUL（人格 prompt）跨群組共用

### 規模評估

- 每群組 1000 則/天 × 365 天 = **36.5 萬則/年**
- 100 群組 × 36.5 萬 = **3650 萬則/年** — SQLite 在 WAL 模式下可處理
- 向量儲存：3650 萬 × 1536 dim × 4 bytes ≈ **210 GB/年** — 需監控，但單檔案可行
- 單一 DB 檔案 ≈ **300-400 GB/年**（含訊息 + 摘要 + 向量）— 需搭配 Litestream 備份

### Embedding 策略比較

|          | Per-message（舊） | Chunk-based（採用）                      |
| -------- | ----------------- | ---------------------------------------- |
| API 成本 | $0.37/年/群組     | 更低（多則訊息合併為一個 chunk embed）   |
| 資訊損失 | 無                | 極低（reply chain 保留對話脈絡）         |
| 搜尋粒度 | 可找到特定訊息    | 可找到對話片段（reply chain 或連續訊息） |
| 向量數量 | 36.5 萬/年        | 更少（多則訊息合併）                     |

## Schema

### messages

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  external_id TEXT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  reply_to_external_id TEXT
);
CREATE INDEX messages_timestamp_idx ON messages(group_id, timestamp);
CREATE INDEX messages_external_id_idx ON messages(group_id, external_id);
```

- `id`：INTEGER PRIMARY KEY AUTOINCREMENT — SQLite 自動分配，同時作為 sqlite-vec 的 rowid（消除橋接表）
- `group_id`：群組 ID，用於邏輯隔離不同群組的資料
- `external_id`：平台訊息 ID（Discord snowflake / LINE message ID），bot 訊息為 null
- 不需要 `platform`：群組 ID 已隱含平台資訊
- 不需要 `created_at`：`timestamp` 已涵蓋所有時間查詢需求
- `reply_to_external_id`：回覆目標的平台訊息 ID（Discord/LINE），用於 chunking 時追溯 reply chain

### chunks

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  start_timestamp INTEGER NOT NULL,
  end_timestamp INTEGER NOT NULL
);
CREATE INDEX chunks_end_timestamp_idx ON chunks(group_id, end_timestamp);
```

- `content`：chunk 的文字內容（多則訊息合併，格式 `{userId}: {content}`）
- `message_ids`：JSON 陣列，記錄此 chunk 包含的所有 message id
- `start_timestamp` / `end_timestamp`：chunk 的時間範圍
- `end_timestamp` 索引：供 `processNewChunks` 查詢「上次處理到哪裡」

### user_summaries

```sql
CREATE TABLE user_summaries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
);
```

### group_summaries

```sql
CREATE TABLE group_summaries (
  group_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- `group_id` 為主鍵，每個群組一筆記錄
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

### facts

```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  user_id TEXT,
  canonical_key TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX facts_canonical_key_unique ON facts(group_id, canonical_key, scope, COALESCE(user_id, '')) WHERE status = 'active';
CREATE INDEX facts_scope_user_status_idx ON facts(group_id, scope, user_id, status);
```

- `scope`：`'user'`（個人事實）或 `'group'`（群組事實）
- `user_id`：個人事實的擁有者；群組事實為 null
- `canonical_key`：正規化鍵，lowercase snake_case（如 `pet_preference`、`birthday`），用於判斷重複/更新
- `confidence`：信心分數（0~1），低於 `FACT_CONFIDENCE_THRESHOLD` 的事實不注入 context
- `evidence_count`：同一事實被多次觀察到的次數，每次 upsert 遞增
- `status`：`'active'`（有效）/ `'superseded'`（被新事實取代）/ `'contradicted'`（矛盾）
- `pinned`：永遠注入 context，不受 embedding 搜尋結果影響
- UNIQUE 約束：`(canonical_key, scope, COALESCE(user_id, ''))` partial index（僅 `status='active'` 的行參與），確保同一事實不重複建立，且 superseded 行不阻擋新 active 行插入

### fact_metadata

```sql
CREATE TABLE fact_metadata (
  group_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (group_id, key)
);
```

- Per-group key-value store，目前唯一用途是儲存 fact watermark
- `key = 'fact_watermark'`，`value` = 上次 fact extraction 完成的 Unix ms 時間戳
- Watermark 與 summary watermark（`group_summaries.updated_at`）完全獨立，避免兩者之間的原子性問題

### fact_vectors（sqlite-vec 虛擬表）

```sql
CREATE VIRTUAL TABLE fact_vectors USING vec0(
  embedding float[1536]
);
```

- rowid 直接使用 `facts.id`（INTEGER PK），無需橋接表
- 維度由 `EMBEDDING_DIMENSIONS` config 決定
- 由 `initFactVectorTable()` 在 embedding 模組初始化時建立

## Facts 系統（Semantic Collection）

### Hybrid 架構

系統採用 Hybrid 記憶架構，兩種記憶類型互補：

| 類型        | 用途                 | 更新方式                    |
| ----------- | -------------------- | --------------------------- |
| `facts`     | 耐久知識（永久保存） | 萃取後 upsert，不被壓縮覆蓋 |
| `summaries` | 近期印象（定期更新） | Observer 壓縮後整體替換     |

Facts 記住「Alice 養了一隻貓」這類穩定事實，summaries 記住「Alice 最近心情不好」這類近期狀態。兩者不互相干擾——facts 不會被 Observer 壓縮覆蓋，summary 壓縮時則會被告知已知事實以避免重複。

### 萃取機制

- Observer 背景任務觸發時，先萃取 facts，再壓縮 summaries
- Fact extraction 使用獨立 watermark，與 summary watermark 分離——萃取失敗不影響摘要壓縮
- 單次 LLM 呼叫處理所有 user + group facts（非 per-user 拆分）
- 萃取結果可為 insert（新事實）、update（更新同 key 事實）、supersede（取代矛盾事實）

### Context 注入

Facts 依兩種方式注入 AI context：

- **Pinned facts**：永遠注入，不受 embedding 狀態影響
- **Semantic search facts**：embedding 啟用時，依語義相關性搜尋相關 facts，與 chunk 搜尋共用同一次 embedding 計算

Token 超出預算時，按優先序裁剪——搜尋到的 facts 先裁、pinned facts 後裁、SOUL 永不裁。

## DB 檔案結構

```
data/
└── yamada.db          # 所有群組的資料（以 group_id 邏輯隔離）
```

### openDb / closeDb

- `openDb(dbPath, dimensions)` — 開啟（或建立）SQLite DB，初始化 schema + sqlite-vec 擴充
- `closeDb(appDb)` — 關閉 DB 連線（注意：不執行 WAL checkpoint，由 Litestream 接管 WAL 管理）
- 回傳 `AppDb = { db, sqlite }` 供應用程式使用

### 向量搜尋流程

```
messages → buildChunks() → ChunkInput[]
saveChunk(db, groupId, chunk) → chunks.id (INTEGER PK) → 直接作為 sqlite-vec rowid
insertChunkVector(db, chunkId, embedding) → INSERT（手動冪等）
searchSimilarChunks(db, groupId, queryEmbedding, topK, threshold) → { chunkId, distance }[]
getChunkContents(db, chunkIds) → string[]（chunk 文字內容）
context.ts → <related_history> 區塊
```

## 設計演進

### 從 Per-Group DB 遷移到 Single DB

早期架構使用每個群組獨立 DB 檔案（`data/groups/{groupId}.db`），後遷移至單一統一 DB（`data/yamada.db`）。

遷移原因：

- 簡化部署與備份（Litestream 單一檔案 WAL 備份）
- 減少大量小檔案對檔案系統的壓力
- 統一的 schema 管理與連線池

隔離方式：

- 所有表都包含 `group_id TEXT NOT NULL` 欄位
- 所有查詢都帶 `group_id` 條件
- 索引皆為複合索引（`group_id, ...`）確保查詢效率

## 風險評估

| 風險                    | 嚴重度 | 緩解措施                                                 |
| ----------------------- | ------ | -------------------------------------------------------- |
| 單一 DB 檔案過大        | 中     | 預估 100 群組 × 1 年 = 300-400 GB，需監控並規劃歸檔策略  |
| WAL 檔案增長            | 低     | Litestream 持續備份 WAL，自動 checkpoint                 |
| Schema 變更影響所有群組 | 低     | 程式化 init 用 IF NOT EXISTS / ALTER TABLE IF NOT EXISTS |
| 備份一致性              | 低     | Litestream 提供 point-in-time recovery                   |

## 附錄：Agent 框架記憶架構參考

研究了 Letta/MemGPT、Mem0、LangChain、CrewAI 的記憶架構後，關鍵發現：

- **所有框架都沒有訊息 GC 機制** — 它們假設單一 agent 場景
- **Letta** 最成熟：Core Memory（context 內）+ Recall Memory（全歷史）+ Archival Memory（向量）
- **Mem0** embed 萃取後的「事實」而非原始訊息（成本更高、有資訊損失）
- **我們的系統** 結合了 Letta 的分層概念（summaries = Core、messages = Recall、vectors = Archival），但用物理隔離取代 Letta 的邏輯隔離；並加入 Mem0 的 facts 概念，但採 Hybrid 架構（facts 耐久、summaries 近期），避免 Mem0 純 facts 方案的資訊損失問題
