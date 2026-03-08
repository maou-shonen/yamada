# 部署指南

Yamada 使用 Docker 容器化部署，搭配 CI/CD 自動構建推送至私有 registry，由 homelab 的 doco-cd 偵測新映像並自動更新。

## 架構概覽

```
推送至 main → CI 構建映像 → 推送私有 registry → doco-cd 偵測 → 重建容器
```

## 前置需求

- Docker / Docker Compose
- 私有 Docker Registry（Harbor、Gitea Container Registry 等）
- doco-cd（監控 registry 並自動更新容器）

## Docker 映像

### 本地構建

```bash
docker build -t yamada .
```

映像特性：

- **基底**：`oven/bun:1-slim`（Debian slim）
- **多階段構建**：依賴安裝與執行環境分離，縮小最終映像
- **原生擴充**：`sqlite-vec` 的 prebuilt `.so` 隨 npm 安裝自動包含
- **映像大小**：約 285 MB

### CI 自動構建

`.github/workflows/deploy.yml` 在推送至 `main` 分支時自動構建並推送映像。

#### 需設定的 Secrets / Variables

| 類型     | 名稱                | 說明                      |
| -------- | ------------------- | ------------------------- |
| Secret   | `REGISTRY_URL`      | Registry 位址             |
| Secret   | `REGISTRY_USERNAME` | Registry 帳號             |
| Secret   | `REGISTRY_PASSWORD` | Registry 密碼             |
| Variable | `REGISTRY_IMAGE`    | 映像名稱（預設 `yamada`） |

每次構建產生兩個 tag：

- `latest` — doco-cd 監控用
- `<commit-sha>` — 版本追溯用

## Docker Compose 設定

```yaml
services:
  yamada:
    image: your-registry.local/yamada:latest
    container_name: yamada
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"    # LINE Webhook（僅使用 LINE 時需要）
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    stop_grace_period: 35s  # 略高於 SHUTDOWN_TIMEOUT_MS（30s）
```

## 持久化

容器內兩個目錄需掛載至 host：

| 容器路徑    | 內容                                                        | 重要性 |
| ----------- | ----------------------------------------------------------- | ------ |
| `/app/data` | `yamada.db`（所有群組訊息/摘要/向量，以 group_id 邏輯隔離） | 關鍵   |
| `/app/logs` | 日誌輪替檔案                                                | 建議   |

**建議使用 bind mount**（`./data:/app/data`），不使用 named volume，方便直接存取與備份。

### 備份

SQLite 使用 WAL mode，備份時需包含 `.db-wal` 和 `.db-shm` 檔案。

```bash
# 每日備份（加到 host crontab）
0 4 * * * cd /path/to/yamada && tar czf backups/yamada-$(date +\%Y\%m\%d).tar.gz data/
```

## 網路

| 平台    | 方向     | 說明                                                  |
| ------- | -------- | ----------------------------------------------------- |
| Discord | Outbound | WebSocket 長連線，不需開放任何 port                   |
| LINE    | Inbound  | Webhook 需要 **HTTPS** 公開 URL，指向容器的 port 3000 |

### LINE Webhook 入口方案

| 方案              | 適用情境                | 說明                                             |
| ----------------- | ----------------------- | ------------------------------------------------ |
| Cloudflare Tunnel | 無公網 IP / 不想開 port | `cloudflared tunnel` 指向 `localhost:3000`，免費 |
| Reverse Proxy     | 有公網 IP + 域名        | Caddy / Nginx，Caddy 可自動 HTTPS                |
| Tailscale Funnel  | 已在用 Tailscale        | 一行指令開 HTTPS                                 |

## 環境變數

所有設定透過 `.env` 檔案注入（`env_file: .env`），完整清單見 [README.md](../README.md#環境變數)。

容器內路徑需對應掛載點：

```bash
DB_PATH=/app/data/yamada.db
LOG_DIR=/app/logs
```

## 資源需求

| 資源 | 建議       | 說明                                                 |
| ---- | ---------- | ---------------------------------------------------- |
| CPU  | 1 vCPU     | 大部分時間 idle，等待 debounce / API 回應            |
| RAM  | 256–512 MB | Bun runtime + SQLite 快取                            |
| Disk | 依群組數   | 所有群組共用單一 DB，每群組約數十 MB（向量索引為主） |
