# HACTL RCL 自動下載工具

自動登入 [cargo.hactl.com](https://cargo.hactl.com) → 開啟 **COSAC-Plus** → 選 Profile **Betata** →
輸入指令 **PAL** → 填 Accept Date / Airline → 搜尋 → **逐筆下載 RCL PDF** 到你的「下載」資料夾,
檔名為 `MAWB RCL.pdf` (例: `157-53711873 RCL.pdf`)。

## ✅ 現況 (2026-08-16 已實測行通)

完整流程已驗證成功:ADFS 登入 → COSAC-Plus → Betata → PAL → 填日期/航空公司 → 搜尋 → 開詳細 →
F2 → Save As(按 SPACE)→ 自動儲存 PDF, 檔名正確。已下載嘅 MAWB 會記錄喺 `data/downloaded.json`,
下次自動跳過。

### 實測中解決過嘅特殊位 (方便日後參考)

- **登入**:cargo.hactl.com 首頁冇登入表單, 要按「LOGIN」入口 → 跳去 **Microsoft ADFS SSO**
  (`sso.hactl.com/adfs/...`), 帳號 `#userNameInput`、密碼 `#passwordInput`、按鈕 `#submitButton`
- **指令框**:主畫面頂部係 Kendo combobox(`placeholder="Search Function Here"`), 要**逐字輸入** PAL
- **Airline**:Kendo combobox 自動完成會搞亂輸入, 用「慢速逐字輸入 + 讀回值核對」解決
- **Save As**:F2 彈出嘅 Kendo 對話框有遮罩攔截滑鼠點擊, **按 SPACE 等於按 Save As** (對話框預設焦點)

## 事前準備 (只需一次)

1. 確認已安裝 [Node.js](https://nodejs.org) LTS (檢查方法: 開 cmd 輸入 `node -v` 有版本號即可)。
2. 本機已安裝 **Google Chrome** (預設使用; 如無, 會自動改用 Edge)。

## 啟動方法

1. **雙擊 `start.bat`** (第一次會自動 `npm install`, 需連接互聯網, 約 1-2 分鐘)。
2. 瀏覽器會自動開啟 **http://localhost:3090** (如沒有, 手動打開)。
3. 在「設定」卡輸入你的 HACTL **帳號 / 密碼**, 確認儲存資料夾 (預設是你的下載資料夾), 按 **儲存設定**。
   - 密碼留空 = 不更改已儲存的密碼 (日後改密碼只需重新輸入一次)。
4. 在「執行下載」卡: Accept Date 預設是今天 (格式 `15AUG26`), Airline 預設 `QR`, 按 **開始下載**。
5. 觀看「執行紀錄」即時進度。完成後「已下載檔案」會列出新下載的 RCL。

## 重點行為

- **自動跳過已下載的 MAWB**: 同一 MAWB 的 RCL 不會重複下載 (以檔案存在 + `data/downloaded.json` 記錄判斷)。
- **登入 session 會保留**: 第一次登入後, 之後執行未必需要重新登入 (Cookie 存於 `.browser-data` 資料夾)。
- **停止**: 按「停止」會在完成目前步驟後結束; 瀏覽器視窗可直接看到自動化過程。
- **截圖診斷**: 每一步都會在 `screenshots/<執行編號>/` 存一張截圖, 卡住時看最新一張就知道在哪一步。

## 若執行不順

內部系統 (COSAC) 的畫面結構我無法在此環境預先確認, 第一次執行可能需要微調元素定位。
若在某一步停住, 請:

1. 查看「執行紀錄」最後幾行, 以及 `screenshots/<執行編號>/` 最新的截圖;
2. 把「執行紀錄」內容或截圖檔案告訴我, 我會更新 `src/automation.js` 的 selector 後你重試。

## 檔案結構

```
HACTL RCL/
├─ start.bat          # 一鍵啟動
├─ server.js          # 本地網頁伺服器 + API (http://localhost:3090)
├─ src/
│  ├─ automation.js   # Playwright 自動化核心 (可調整 selector)
│  └─ config.js       # 設定檔讀寫
├─ public/            # 網頁介面
├─ data/
│  ├─ config.json     # 你的帳密及設定 (不會上傳)
│  └─ downloaded.json # 已下載 MAWB 記錄
├─ .browser-data/     # 瀏覽器 session (登入狀態)
└─ screenshots/       # 每步截圖
```

## 停止服務

關閉 start.bat 的黑色視窗 (或按 Ctrl+C) 即可, 不影響已下載的檔案。

---

### 後續可加功能 (待你決定)

- 定時自動重查 (例如每 10 分鐘) 並自動下載新出現的 RCL
- 把 RCL 數據 (如 MAWB、航班、件數、重量) 寫入 `HC HIN LISTING.xlsx`
- 多航空公司 / 多日期批次執行
