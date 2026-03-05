# ── 階段 1：安裝依賴 ──
FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── 階段 2：Litestream binary ──
FROM litestream/litestream:0.3.13 AS litestream

# ── 階段 3：執行環境 ──
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY litestream.yml /etc/litestream.yml

# 資料 & 日誌目錄（作為 volume 掛載點）
RUN mkdir -p /data /app/logs

# LINE Webhook 預設埠
EXPOSE 3000

CMD ["litestream", "replicate", "-config", "/etc/litestream.yml", "-exec", "bun run src/index.ts"]
