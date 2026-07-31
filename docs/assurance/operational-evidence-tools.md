# 本機驗證與營運證據工具

這些工具產生範圍明確、可重跑的本機證據。每一份結果只支持它實際檢查的來源、artifact、migration、Log 或本機環境；不能改寫成 CI、staging、production、正式獨立 QA 或外部使用證據。

## 可執行 Gherkin 驗收情境

```powershell
npm run test:gherkin
```

目前結果為 8 個情境、28/28 steps 通過。情境涵蓋選定的授權、證據、服務狀態、未結案篩選與通訊規則。步驟定義與產品原始碼位於同一 repository，因此不是獨立的正確性判準，也不取代 API、D1、瀏覽器、安全或外部使用測試。

### Gherkin 規則故障注入

```powershell
npm run test:gherkin:fault-injection
```

`CO-VRF-GHERKIN-FAULT-001` 的 6/6 個手工設計規則故障都被對應情境抓到，0 survived。六項風險涵蓋事件轉換授權、角色相容性、HTTPS 工作證據、淘汰服務、未結案篩選與最終通訊標記。它不是完整 mutation campaign 或 mutation score，不代表所有需求；feature、步驟定義與產品來源位於同一 repository，也不是獨立人類 QA。

## 單元 coverage 與複雜度診斷

```powershell
npm run test:quality
```

目前 29/29 單元測試通過；整體 line、branch、function coverage 分別為 95.38%、82.47%、87.88%。複雜度門檻 15 目前有 4 個診斷項目；這些項目用來安排檢視，不是單獨的功能失敗。現有 coverage 輸出無法可靠對回相同函式的複雜度，因此不計算 CRAP，避免產生不可重現的數字。

## 風險導向故障注入

```powershell
npm run test:fault-injection
```

目前 18/18 個指定故障都讓既有測試如預期失敗，0 survived。這表示測試能辨識這 18 個規則弱化，不是完整 mutation testing，也不代表所有規則都有相同判別力。

## Agent 設計的本機黑箱查核

```powershell
npm run test:blackbox:local -- `
  --base-url http://localhost:3001 `
  --expected-build-sha256 1d8b2d0c99000fb1d6b58b23de97adadba06210f370ddcb03e41c95468cf9158 `
  --expected-deployment-version <本機部署標記>
```

目前 12/12 通過。案例由未參與功能實作的 agent 事前凍結，並從公開 HTTP 介面執行；執行者仍在相同 repository 與本機環境，所以狀態為 `verified_local_agent_designed`，不是正式 G7、外部人員或委託第三方證據。

## 短時唯讀本機負載

```powershell
npm run test:load:local
```

目前 590/590 回應符合契約，最高同時請求數為 50，5xx 為 0。這是短時、唯讀、合成資料的本機 smoke；延遲與 throughput 只能描述當次電腦，不是 production 容量、壓力極限、soak、寫入競爭、SLO 或 rate limiting 結論。

## 資料庫未就緒與恢復

```powershell
npm run test:failure-recovery:local
```

工具先以未套 migration 的隔離 D1 啟動相同 Worker，確認 health 回傳 503 與穩定問題代碼；再對同一狀態套用 0001–0004、重啟 Worker，核對 health、access、overview。當次 migration 為 5,441 ms，恢復後 3 個核心讀取通過。這不是網路中斷、部分遠端 D1 故障、rollback、RTO 或 RPO。

## Request telemetry 分析

```powershell
node scripts/analyze-request-telemetry.mjs `
  --input .wrangler/local-release-preview.stdout.log `
  --smoke evidence/continuity-ops-security-negative-tests.json `
  --expected-api 2.2.0 `
  --expected-schema 0004 `
  --expected-deployment <本機部署標記>
```

分析器接受直接 JSON console line 與 Wrangler tail JSON 的 `logs[].message[]`。它要求固定欄位、拒絕未知或敏感欄位，並檢查狀態、問題代碼及 API／schema／deployment version。目前 879/879 筆有效，其中 51 筆為預期 4xx、5xx 為 0。結果不包含 request body、header、cookie、token、actor 資料或自由文字，也不代表 production ingestion、retention、sampling 或告警已完成。

## 隔離本機 D1 logical backup 與 restore

```powershell
node scripts/run-local-d1-restore-drill.mjs
```

工具建立互相分離的來源與還原狀態，套用 migration、加入受控 marker、匯出 SQL、匯入空白狀態，再比較每個應用資料表、migration history、foreign key 及備份雜湊。目前來源與還原端各 15 個資料表、4/4 migration、兩端 foreign key 違反 0，總耗時 26,273 ms。

工具不接受 `--remote`，也不會讀寫一般本機 D1 狀態。耗時不是 RTO；結果不驗證 D1 Time Travel、hosted retention、remote 權限、staging 或 production。

## 內部瀏覽器與 Axe 核對

瀏覽器結果保存於 `evidence/continuity-ops-browser-qa.json`。目前在 1280×720 與 320×568、單一瀏覽器引擎核對鍵盤 tabs、modal 焦點回復、手機 drawer、深層連結、前進後退及兩分頁輪詢由 38 更新為 39。Axe 4.12.1 在選定規則中回報 0 violation、0 incomplete。

自動掃描無法判斷所有可及性要求。這份結果不是完整 WCAG 2.2 AA、人工可及性、真實螢幕閱讀器、跨瀏覽器或真實裝置證據。

## Clean-room 隔離快照驗證

```powershell
npm run test:clean-room
```

`CO-VRF-CLEAN-ROOM-001` 的狀態為 `verified_local_controlled`，結果為 `passed_with_documented_limits`。工具複製 93 個來源快照檔到隔離暫存目錄；17 個命令均 exit 0，包含 `npm ci`、關卡、建置、migration 與 API 27 正向加 44 負向，共 71/71。每次執行的來源快照 SHA-256、隔離 Worker SHA-256 與耗時記錄於證據 JSON，不在說明文件複製容易過期的數值。

來源是目前未提交工作目錄的複本，不是 clean Git checkout、CI 或 commit-bound release。vinext 產生的不同 digest 不證明 bit-for-bit 可重現；本機合成 D1／身分不涵蓋 staging、production、hosted identity、外部服務或外部使用者；自動內部執行也不是正式獨立人類 QA。

## 工具本身的測試

```powershell
npm run test:tools
```

目前 14/14 通過，涵蓋 telemetry、D1 restore 與 secret scanner 的 known-good／known-bad。工具測試通過表示工具能辨識這些固定案例，不代表 production 資料、遠端備份或未知秘密格式已驗證。
