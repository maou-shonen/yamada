# ── 階段 1：安裝依賴 ──
FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── 階段 2：執行環境 ──
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# 資料 & 日誌目錄（作為 volume 掛載點）
RUN mkdir -p /app/data/groups /app/logs

# LINE Webhook 預設埠
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
