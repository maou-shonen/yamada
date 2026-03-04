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

### facts

```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  user_id TEXT,
  canonical_key TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(canonical_key, scope, user_id)
);
CREATE INDEX facts_scope_user_status_idx ON facts(scope, user_id, status);
```

- `scope`：`'user'`（個人事實）或 `'group'`（群組事實）
- `user_id`：個人事實的擁有者；群組事實為 null
- `canonical_key`：正規化鍵，lowercase snake_case（如 `pet_preference`、`birthday`），用於判斷重複/更新
- `confidence`：信心分數（0~1），低於 `FACT_CONFIDENCE_THRESHOLD` 的事實不注入 context
- `evidence_count`：同一事實被多次觀察到的次數，每次 upsert 遞增
- `status`：`'active'`（有效）/ `'superseded'`（被新事實取代）/ `'contradicted'`（矛盾）
- `pinned`：永遠注入 context，不受 embedding 搜尋結果影響
- UNIQUE 約束：`(canonical_key, scope, user_id)` 確保同一事實不重複建立

### fact_metadata

```sql
CREATE TABLE fact_metadata (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

- Singleton key-value store，目前唯一用途是儲存 fact watermark
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

### 設計決策：Hybrid 架構

系統採用 Hybrid 記憶架構，兩種記憶類型互補：

| 類型        | 用途                 | 更新方式                    |
| ----------- | -------------------- | --------------------------- |
| `facts`     | 耐久知識（永久保存） | 萃取後 upsert，不被壓縮覆蓋 |
| `summaries` | 近期印象（定期更新） | Observer 壓縮後整體替換     |

兩者各司其職：facts 記住「Alice 養了一隻貓」這類穩定事實，summaries 記住「Alice 最近心情不好」這類近期狀態。Summary 壓縮時會收到 pinned facts 清單，並被告知不要重複已知事實，避免資訊冗餘。

### Fact Extraction 流程

Observer 背景任務觸發後，fact extraction 在獨立的 try-catch 中執行，失敗不中斷後續的 summary 壓縮。

**完整 Observer 流程：**

1. `shouldRun()` 檢查（使用 summary watermark 計算新訊息數）
2. 取得 fact watermark（`fact_metadata` 中的 `fact_watermark`）
3. 取得 fact watermark 之後的非 bot 訊息
4. `getAllActiveFacts()` 取得現有所有 active facts（供 LLM 判斷重複/矛盾）
5. `extractFacts()` — 單次 LLM 呼叫（`generateObject` + Zod schema，失敗時 fallback 到 `generateWithFallback` + JSON.parse）
6. 套用萃取結果：`upsertFact()`（新事實或更新同 canonical_key）/ `supersedeFact()`（矛盾替代）
7. `processNewFactEmbeddings()` — 為新 facts 建立向量索引
8. `setFactWatermark(Date.now())` — 更新 fact watermark
9. 取得 pinned facts 供 summary prompt 使用
10. `compressGroupSummary()` — 傳入 pinned facts，告知 LLM 不要重複
11. `compressUserSummaries()` — 各用戶各自傳入其 pinned facts

**Watermark 獨立性：** Fact watermark 儲存在 `fact_metadata` 表，與 summary watermark（`group_summaries.updated_at`）完全獨立。兩者分開是為了避免 fact extraction 與 summary compression 之間的原子性問題——即使 fact extraction 失敗，summary watermark 仍可正常推進。

**canonical_key 格式：** lowercase snake*case，例如 `pet_preference`、`birthday`、`hometown`。萃取時自動正規化（`.toLowerCase().replace(/\s+/g, "*").replace(/[^a-z0-9_]/g, "")`）。

### Context 注入方式

Facts 注入 context 有兩個來源，分別處理：

**Pinned facts（永遠注入）：**

- 不受 embedding 狀態影響，即使 embedding 功能關閉也會注入
- 透過 `getPinnedFacts(db)` 取得所有 pinned facts
- 過濾條件：`confidence >= FACT_CONFIDENCE_THRESHOLD`（預設 0.5）

**Semantic search facts（embedding 啟用時）：**

- 用最後一則非 bot 訊息的 embedding 搜尋相關 facts
- 搜尋參數：`CONTEXT_FACT_TOP_K`（預設 5）、`CONTEXT_FACT_THRESHOLD`（預設 0.7）
- 過濾條件：`confidence >= FACT_CONFIDENCE_THRESHOLD` 且非 pinned（避免與 pinned 重複）
- 與 chunk 語義搜尋共用同一次 embedding 計算（`queryEmbedding` 計算一次，兩者共用）
- 獨立 try-catch：fact 搜尋失敗不影響 chunk 搜尋，反之亦然

**XML 格式：**

```xml
<group_facts>
群組事實 1
群組事實 2
</group_facts>

<user_facts>
Alice: 用戶事實 1
Bob: 用戶事實 2
</user_facts>
```

### Context 組裝順序與 Token Trimming

**組裝順序（優先序由高到低）：**

```
SOUL > group_summary > group_facts > user_profiles > user_facts > related_history
```

**Token Trimming 順序（最先裁剪 → 最後裁剪）：**

| 順序 | 區塊                   | 說明                                  |
| ---- | ---------------------- | ------------------------------------- |
| 1    | `related_history`      | 語義搜尋的歷史 chunk，最先犧牲        |
| 2    | `user_facts` searched  | 非 pinned 的用戶 facts（保留 pinned） |
| 3    | `group_facts` searched | 非 pinned 的群組 facts（保留 pinned） |
| 4    | `user_profiles`        | 用戶摘要                              |
| 5    | `group_summary`        | 群組摘要                              |
| 6    | `SOUL`                 | 永不裁剪                              |

Pinned facts 在 trimming 中受到保護：trimming 只移除 searched（non-pinned）部分，pinned facts 保留到最後。

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
- **我們的系統** 結合了 Letta 的分層概念（summaries = Core、messages = Recall、vectors = Archival），但用物理隔離取代 Letta 的邏輯隔離；並加入 Mem0 的 facts 概念，但採 Hybrid 架構（facts 耐久、summaries 近期），避免 Mem0 純 facts 方案的資訊損失問題
