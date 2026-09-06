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

---

## 🖥️ 跨平台使用 + 📂 已下載檔案管理員 (v0.2+)

### 喺其他 PC / MacBook 使用

- **Windows**: 照舊雙擊 `start.bat`
- **macOS / Linux**: 雙擊 `start.command` (第一次要 `chmod +x start.command`), 或者喺 Terminal 入面直接 `npm start`
- `data/`、`screenshots/`、`.browser-data/` 全部係相對路徑, 成個資料夾抄去另一部機即可用
- 唔同 OS 會自動用返該平台嘅「開啟資料夾 / 檔案」指令: Windows → 檔案總管 (`explorer`), macOS → Finder (`open`)

### 由另一部機開 UI (LAN, 可選)

預設淨係 bind `127.0.0.1` (最安全, 淨係本機用到)。想由 LAN 其他機開:

```
set HOST=0.0.0.0     # Windows
# 或
export HOST=0.0.0.0  # macOS / Linux
node server.js
```

之後喺其他機開 `http://<主機IP>:3090`。
📡 **遠端檢視時**,「系統開啟 / 喺檔案管理員顯示」會自動隱藏 (檔案喺主機), 淨係留返 頁內預覽 / 下載 / 複製路徑。因為 `data/config.json` 存有 HACTL 帳密, 遠端使用請自行加 VPN / 防火牆 / 認證限制。

### 📂 已下載檔案卡可以用嘅嘢

- 頂部 **位址列**: 顯示目前儲存資料夾; 撳一下即複製路徑; 「開啟資料夾」直接喺系統檔案管理員開啟 (本機限定)
- 每行 hover 浮現: 🔍 頁內預覽 / ⬇ 下載 / 🖥️ 系統開啟 / 📂 顯示位置 / ⧉ 複製路徑
- **雙擊一行** = 右側滑出 PDF 預覽 (唔離開頁面); Drawer 內可再「新分頁開 / 下載 / 系統開啟」
- **懸停**一行約半秒 = Quick Look 第一頁縮圖 (pdf.js, 完全離線, 首次載入會慢少少)
- **Ctrl/Cmd+K** 或按 `/` = Command Palette 搜尋 MAWB 檔名, Enter 即預覽
- **搜尋框**即時過濾; **排序**可揀「最新優先 / 檔名 / 分組(今日 · 今週 · 較早)」
- **勾選多行** → 批次下載 / 預覽第一份
- 下載任務完成會彈 toast「新下載」+ 一鍵動作; 新檔喺表格會有「新」badge

### 測試用環境變數

- `NO_OPEN=1`: server 啟動時唔會自動開瀏覽器 (例如自動化測試)
- `PORT=3091`: 改用另一個端口

### ⏱ 定時自動重查

- 喺「設定」卡「自動重查間隔 (分鐘)」輸入 N (例: 10), 按「儲存設定」。
- 每次執行完成後 (包括手動或自動), 會隔 N 分鐘自動再查一次「今日」嘅 RCL, 新出現嘅會自動下載, 已下載嘅自動跳過。
- 「執行下載」卡有即時狀態 chip: `⏱ 每 10 分自動重查 · 下次 09:58` (每秒倒數)。
- 自動執行緊時, 頁頂狀態會顯示「⏱ 自動執行中 (定時重查)」; 撳「停止」只停當次。
- 設 0 或清空 = 關閉。Server 重啟後會沿用上次設定 (存喺 `data/config.json` 嘅 `autoCheckMinutes`)。
- **自動暫停**: MAWB 清單非空而全部 tick (skip) → 已無嘢可下載, 自動重查會自動暫停 (唔會再每 N 分鐘登入), chip 顯示「⏸ 已暫停 (全部已下載)」。取消任何 tick / 加新 MAWB / 清空清單後, 再按「開始下載」或「儲存設定」即自動重啟。
- 如果想「全日自動捉新出現嘅 RCL」: 將 MAWB 清單**清空** (空清單 = 下載嗰日全部新 Type P/B, 已存在自動跳過), 咁自動重查先會捉到清單以外嘅新 MAWB。

### 👤 個人切換 (軒仔 / 劉鏘鏘, v0.3+)

- 頁頂有「軒仔 | 劉鏘鏘」pill;每人有獨立設定 (Airline / 儲存資料夾 / MAWB 清單 / XLS 同步),
  存放喺 `data/profiles/<id>.json`;HACTL 帳密共用存喺 `data/config.json`。
- 切換 = 成套設定換人 (網頁會自動 reload)。

### 📊 劉鏘鏘: DL RCL 同時自動更新 XLS (v0.3+)

- 「XLS 同步」卡:揀/拖 `HC HIN LISTING.xlsx`(預設建議 = project root 嗰份),揀 worksheet(預設最左張=當月)。
- 每次執行完成後,會將下載到嘅 RCL 抽返數值 (詳細頁 DOM → 唔夠先由 RCL PDF fallback),自動:
  - 只改「A 欄 = 11 位數字」嘅資料行,block header / `.` / `TOTAL n MAWB` 行一律唔郁;
  - DEST 核對 / PCS (P 跟 XLS, B/X 跟 RCL) / WT 跟 RCL (>5% 通知) / CBM 只 B / TYPE 核對 /
    ULD#・Contour・Tare 空白先填 / remark LIH=N 填 `no LIH` / accept? 下載成功填 1;
  - 差異會寫入該行 remark (例 `WT>5%`) 並喺頁面「⚠ 差異通知」列出;
  - Type X (mix-load):同一 MAWB 喺唔同 ULD RCL 出現時,會喺原 MAWB 行下面自動插新行;
  - 寫入前自動備份去 `<xls 所在資料夾>/.hactl-backup/`;Excel 開住個檔會提示關閉後再補寫。
- 測試:`npm test`
