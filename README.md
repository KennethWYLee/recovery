# 課堂小組回應與全班排序系統

這是一套供大學課堂使用的小組作答與全班完整排序系統。教師可管理課程；通過審核的使用者可在 `/courses` 選擇課程，系統管理員可在 `/access-review` 審核登入申請。

## 目前已實作

- 六門預設課程：資料庫、IoT、智慧金融科技、商業智慧、機器學習、AI 量化交易。
- 課程的新增、改名與刪除。
- 固定系統管理員：`wy.lee@ntub.edu.tw`、`kenneth.wy.lee21@gmail.com`。
- 其他使用者必須使用 `@ntub.edu.tw` 信箱，並經系統管理員核准後才可進入。
- 系統管理員可查看待審核、已核准與已拒絕的申請，並執行審核。
- 課程資料與存取審核資料保存於 Cloudflare D1。

課堂題目、小組隨機分組、拖曳調整組別、小組代表作答、個人完整排序、投影模式、結果圖表與匯出仍屬後續開發範圍。

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

`.openai/hosting.json` 將資料庫綁定為 `DB`。真實 `.dev.vars` 不得提交版本控制。
