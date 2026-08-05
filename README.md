# 課堂小組回應與全班排序系統

這是一套供大學課堂使用的小組作答與全班完整排序系統。教師可管理課程；通過審核的使用者可在 `/courses` 選擇課程，系統管理員可在 `/access-review` 審核登入申請。

## 目前已實作

- 六門預設課程：資料庫、IoT、智慧金融科技、商業智慧、機器學習、AI量化交易。
- 課程的新增、改名與刪除，可設定學年、學期及每組人數上限。
- 固定系統管理員：`wy.lee@ntub.edu.tw`、`kenneth.wy.lee21@gmail.com`。
- 其他使用者必須使用 `@ntub.edu.tw` 信箱，並經系統管理員核准後才可進入。
- 系統管理員可查看待審核、已核准與已拒絕的申請，並執行審核。
- 課程資料與存取審核資料保存於 Cloudflare D1。
- 教師建立今日問題後，系統產生 QR Code 與六碼課堂代碼。
- 學生報到後平均隨機分組；教師可拖曳調整、指定作答代表。
- 遲到學生補入人數最少的現有小組，不自動增加組數。
- 小組回答、教師展示、排除自己組的個人完整排序、同分判定及名次分布圖。
- 只有系統管理員可查看個人原始排序與匯出 CSV。

專用投影模式、已封存課堂的歷史檢視、名單批次匯入、XLSX 匯出及異常排序作廢，仍屬後續開發範圍。

## 本機執行

需要 Node.js 22.13.0 以上版本。

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

開啟 `http://localhost:3000/courses`。本機預設身分只供開發使用；正式環境必須使用託管平台提供的已驗證身分標頭。

## 驗證

```powershell
npm run gate:ci
```

此命令執行秘密掃描、型別檢查、ESLint、課堂領域單元測試、正式建置與建置產物檢查。生產相依套件稽核可另行執行：

```powershell
npm run audit:production
```

## 資料結構

部署 migration 位於：

- `drizzle/0001_classroom_courses.sql`
- `drizzle/0002_classroom_access_approval.sql`
- `drizzle/0003_classroom_live_sessions.sql`

`.openai/hosting.json` 將資料庫綁定為 `DB`。本機 migration 使用 `wrangler.local.jsonc`；真實 `.dev.vars` 不得提交版本控制。
