# LINE 平台設定指南

## 建立 LINE Messaging API Channel

1. 前往 [LINE Developers Console](https://developers.line.biz/)，以 LINE 帳號登入
2. 建立或選擇一個 **Provider**
3. 點擊「Create a new channel」，選擇 **Messaging API**
4. 填寫 Channel 基本資訊（名稱、描述、圖示等），完成建立

## 取得憑證

在 Channel 頁面中取得以下兩組值：

| 憑證                     | 位置                                               | 對應環境變數                |
| ------------------------ | -------------------------------------------------- | --------------------------- |
| **Channel Secret**       | Basic settings → Channel secret                    | `LINE_CHANNEL_SECRET`       |
| **Channel Access Token** | Messaging API → Channel access token（點擊 Issue） | `LINE_CHANNEL_ACCESS_TOKEN` |

將它們寫入 `.env`：

```env
LINE_CHANNEL_SECRET=your-channel-secret
LINE_CHANNEL_ACCESS_TOKEN=your-channel-access-token
```

## 設定 Webhook

Bot 啟動後會在指定 port 開啟 HTTP server，接收 LINE 平台的 webhook 事件。

### Webhook URL 格式

```
https://<your-domain>:3000/webhook/line
```

- 預設 port 為 `3000`，可透過環境變數 `LINE_WEBHOOK_PORT` 調整
- LINE 要求 **HTTPS**，本地開發需使用 ngrok 等 tunnel 工具

### 在 LINE Developers Console 設定

1. 進入 Channel → **Messaging API** 頁籤
2. 在「Webhook URL」欄位填入你的 URL
3. 點擊「Verify」確認連線成功
4. 啟用「Use webhook」開關

### 關閉自動回覆

在 **Messaging API** 頁籤底部，點擊「Auto-reply messages」旁的「Edit」，進入 LINE Official Account Manager：

- **自動回應訊息**：關閉
- **加入好友的歡迎訊息**：依需求開關

> 不關閉自動回覆的話，LINE 官方帳號會對每則訊息自動回覆預設文字，與 bot 回覆重複。

## 邀請 Bot 到群組

1. 在 LINE Developers Console → **Messaging API** 頁籤，掃描 QR code 加 bot 為好友
2. 在 LINE app 中建立或進入群組
3. 邀請 bot 帳號加入群組

> Bot 僅處理**群組訊息**，私訊（DM）會收到「暫不支援私訊功能」的回覆。

## 環境變數一覽

| 變數                        | 必要 | 預設值 | 說明                         |
| --------------------------- | ---- | ------ | ---------------------------- |
| `LINE_CHANNEL_SECRET`       | 是   | —      | Channel Secret               |
| `LINE_CHANNEL_ACCESS_TOKEN` | 是   | —      | Channel Access Token（長效） |
| `LINE_WEBHOOK_PORT`         | 否   | `3000` | Webhook server 監聽 port     |

兩個必要欄位**必須同時設定**，否則 LINE 平台不會啟用。

## 本地開發

LINE webhook 要求 HTTPS，本地開發建議使用 [ngrok](https://ngrok.com/) 建立 tunnel：

```bash
# 啟動 ngrok tunnel
ngrok http 3000

# ngrok 會顯示類似以下的 URL
# https://xxxx-xx-xx-xx-xx.ngrok-free.app

# 將 Webhook URL 設為：
# https://xxxx-xx-xx-xx-xx.ngrok-free.app/webhook/line
```

每次重啟 ngrok 會產生新的 URL，記得同步更新 LINE Developers Console 中的 Webhook URL。

## 訊息行為

### 回覆策略

Bot 採用 **reply → push fallback** 策略：

1. 優先使用 `replyMessage`（免費，但 replyToken 僅 30 秒內有效）
2. 若 replyToken 過期，fallback 到 `pushMessage`（消耗每月免費推播配額）

### 支援的訊息類型

| 收到的類型 | 處理方式         |
| ---------- | ---------------- |
| 文字       | 正常處理訊息內容 |
| 圖片       | 轉換為 `[圖片]`  |
| 貼圖       | 轉換為 `[貼圖]`  |
| 影片       | 轉換為 `[影片]`  |
| 音訊       | 轉換為 `[音訊]`  |
| 檔案       | 轉換為 `[檔案]`  |
| 位置       | 轉換為 `[位置]`  |

### 長度限制

單則回覆最大 **5000 字元**，超過會自動截斷。

## 常見問題

### Webhook 驗證失敗（401）

- 確認 `LINE_CHANNEL_SECRET` 與 Console 上的值完全一致
- 確認沒有多餘的空白或換行

### Bot 沒有回覆

- 確認「Use webhook」已啟用
- 確認 Webhook URL 正確且 server 可從外部存取
- 確認已關閉自動回覆功能
- 檢查 log 中是否有 `[LINE]` 相關錯誤訊息

### pushMessage 配額用盡

LINE 免費方案的 push 配額有限。若 log 中頻繁出現 `Using pushMessage` 警告，代表 bot 的回覆時間常超過 30 秒（replyToken 過期）。可考慮：

- 使用更快的 AI 模型以縮短回覆時間
- 升級 LINE Official Account 方案以取得更多推播配額
