# pingless-keepalive

[pingless.org](https://pingless.org) 免費伺服器自動保活 + 賺積分腳本，跑在 GitHub Actions 上，附 Telegram 通知。

## 功能

- 🔄 **自動續期**：伺服器每 48 小時需續期一次，剩餘 24 小時內才可續。腳本每 6 小時跑一次，進入窗口自動 `POST /api/server/{id}/renewal/renew`
- 🪙 **每日簽到**：自動領取每日 150 Credits（`POST /api/daily-coins`）
- 👥 **多賬號**：Secrets 裡一個 JSON 陣列加幾個都行
- 📨 **Telegram 通知**：每次執行後推送報告（餘額 / 簽到 / 各伺服器續期狀態）
- 🔍 **自動發現伺服器**：只填 cookie，伺服器列表自動從 `/servers` 頁面解析；也可在配置裡指定 `servers` 陣列

> 每次從新 IP 存取會觸發站方「Sign in from new location」郵件/通知，屬正常現象。

## 配置

### 1. Secrets（倉庫 Settings → Secrets and variables → Actions）

| Secret | 內容 | 必填 |
|---|---|---|
| `PINGLESS_ACCOUNTS` | 賬號 JSON 陣列（見下） | ✅ |
| `TG_BOT_TOKEN` | Telegram bot token | 可選 |
| `TG_CHAT_ID` | Telegram chat id | 可選 |

`PINGLESS_ACCOUNTS` 格式：

```json
[
  {"name": "whfeng578", "cookie": "pingless.sid=s%3Axxxx...."},
  {"name": "account2", "cookie": "pingless.sid=s%3Ayyyy....", "servers": ["40f1e252"]}
]
```

- `cookie`：瀏覽器登入 dash.pingless.org 後，F12 → Application → Cookies → 複製 `pingless.sid` 的**完整值**（含 `s%3A` 開頭；只填 `pingless.sid=` 後面的值也可以，腳本會自動補前綴）
- `servers`：可選。不填就自動發現該賬號名下所有伺服器
- **新增賬號**：往 JSON 陣列加一個物件即可

### 2. 怎麼拿 pingless.sid

1. 瀏覽器登入 `dash.pingless.org`
2. F12 → Application（應用程式）→ Cookies → `https://dash.pingless.org`
3. 找到 `pingless.sid`，整串值複製（`s%3A...` 開頭，URL 編碼原樣即可）

## 運行

- 自動：每 6 小時（UTC 00/06/12/18）
- 手動：Actions → Pingless Keepalive → Run workflow（可勾 `force_renew` 強制嘗試續期）

## 拿積分的其他途徑（無法自動化，需手動）

| 途徑 | 收益 | 說明 |
|---|---|---|
| 每日簽到 | 150/天 | ✅ 腳本自動 |
| Shrtfly 短鏈 | 300/條，24 條/天 | 需真人完成廣告頁，腳本無法代做 |
| Chat to Earn | 0.2/訊息 | 需在指定 Discord 頻道發言 |
| AFK 掛機 | 語音房掛機 | 需 Discord 語音在線 |
| 邀請 Referrals | 按邀請計 | 分享自己的邀請連結 |

## 注意

- `pingless.sid` 失效（重新登入/被登出）時腳本會在 Telegram 報告「cookie 已失效」，更新 Secret 即可
- 倉庫含 keepalive 自動提交，防止 GitHub 60 天無活動停用定時任務
