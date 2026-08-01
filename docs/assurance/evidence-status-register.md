# Continuity Ops 證據狀態登錄

盤點日期：2026-07-31  
用途：明確區分已執行結果、原始碼設計、產生的清單、待執行程序與尚未驗證事項。

目前原始碼基準為產品/API `2.2.0`、schema `0004`。既有 API、資安負例、agent 設計黑箱、短時讀取負載、受控 Log、資料庫未就緒後恢復及瀏覽器查核綁定 Worker SHA-256 `e725a8a8c1cb9b0b41a1b478e6ad0ca6b11c515d673e051ced27c6c92429cedd`；新的 fresh-D1 runtime bootstrap 與校內角色選擇查核綁定 `af852b995266c853facb3d198bd8667198b62c6a7ca6431e35d1152508127286`。兩組 artifact 證據不得混用。各結果只支持明列的 artifact、來源、Log、migration 或本機環境，不能改寫為 CI、staging、production、正式獨立 QA 或外部使用證據。

本系統以獨立 repository 發布，`.github/workflows/ci.yml` 位於 Git root。每次 `main` push 或 pull request 都會執行關卡；只有保存成功 run ID、source commit 與 artifact digest 後，才可把結果列為 `verified_ci`。

## 1. 現有可核對檔案

| 證據 | 檔案 | 記載的狀態 | 可支持的主張 | 不能支持的主張 |
|---|---|---|---|---|
| CO-VRF-API-001 | `evidence/continuity-ops-api-smoke.json` | `verified_local`；71/71，27 正向、44 負向；0 個非預期 5xx；Worker SHA-256 `e725a8a8...29cedd` | 指定 2.2.0 本機 Worker 與隔離 D1 的 API 核心流程、拒絕情境、資料 round-trip、同時冪等請求、同版本競爭更新、安全標頭、生命週期多頁查詢與稽核結果。 | 正式部署、真實身分邊界、hosted edge、外部送達、外部使用者、正式容量或獨立資安查核。 |
| CO-VRF-SEC-001 | `evidence/continuity-ops-security-negative-tests.json` | `verified_local`；44 項負例，`passed_with_documented_limits`；綁定同一 Worker digest | 指定本機 artifact 對列出的授權、狀態、版本、輸入、證據、內容型別、大小限制與資料不變條件負例。 | 正式身分 edge、完整 SAST／DAST／滲透測試、所有 OWASP ASVS 控制或正式環境資安結論。 |
| CO-VRF-GHERKIN-001 | `evidence/continuity-ops-gherkin-acceptance.json` | `verified_local`；1 個 feature、10 個情境、35/35 steps 通過 | 以可讀且可執行的情境核對選定的授權、校內唯讀寫入拒絕、observer 無指派讀取、證據、服務狀態、未結案篩選與通訊規則。 | 全部需求、API／D1／瀏覽器整合、獨立測試者或外部使用者結果。 |
| CO-VRF-GHERKIN-FAULT-001 | `evidence/continuity-ops-gherkin-fault-injection.json` | `verified_local`；`passed`；6/6 個手工設計規則故障被對應情境抓到，0 survived | 六項風險導向弱化分別涵蓋事件轉換授權、角色相容性、HTTPS 工作證據、淘汰服務、未結案篩選與最終通訊標記。 | 只涵蓋目前 10 個情境中的六項風險；不是完整 mutation campaign 或 mutation score，不代表所有需求，也不是獨立人類 QA。 |
| CO-VRF-QUALITY-001 | `evidence/continuity-ops-quality-metrics.json` | `verified_local`；40/40 單元測試；line 92.17%、branch 85.81%、function 93.97%；5 個複雜度診斷項目；CRAP 未計算 | 指定六個單元測試套件及六個領域或 bootstrap source 的整體 coverage 門檻與複雜度診斷；三項 aggregate coverage 均達既定門檻。 | 斷言品質、個別檔案都達 aggregate 門檻、Worker／UI／migration coverage、功能正確性、資安、可用性或發布準備度。 |
| CO-VRF-FAULT-001 | `evidence/continuity-ops-fault-injection.json` | `verified_local`；18/18 個指定故障被既有測試抓到，0 survived | 既有測試可辨識 18 個風險導向的領域、授權、輸入、時間與 cursor 規則弱化。 | 完整 mutation testing、所有規則的判別力或真實故障復原。 |
| CO-VRF-QA-BLACKBOX-001 | `evidence/continuity-ops-independent-blackbox-qa.json` | `verified_local_agent_designed`；12/12 通過；綁定同一 Worker digest | 未參與功能實作的 agent 依事前凍結案例，從公開 HTTP 介面核對 known-good、known-bad、身分 header、版本衝突與資料一致性。 | 正式 G7、外部人員、委託第三方、遠端環境、完整端對端或外部使用證據。 |
| CO-VRF-LOAD-001 | `evidence/continuity-ops-local-load-smoke.json` | `verified_local_controlled`；590/590 有效回應；最高同時 50；0 個 5xx | 短時、唯讀、本機合成資料負載下，所列路徑維持回應格式、request ID 與非 5xx。 | production 容量、壓力極限、長時間穩定性、寫入競爭、SLO、rate limiting 或遠端網路。 |
| CO-VRF-TELEMETRY-001 | `evidence/continuity-ops-request-telemetry-analysis.json` | `verified_local_controlled`、`passed`；815/815 筆有效；761 筆成功、54 筆受控 4xx、0 筆 5xx；安全負向檢查對應 44/44；API／schema／deployment version 一致 | 目前受驗本機 Wrangler Log 的欄位白名單、明確分母、問題代碼、狀態、版本一致性及指定安全負向請求的對應。 | 正式 ingestion、retention、sampling、告警、production 負載延遲或生產可觀測性。 |
| CO-VRF-BROWSER-001 | `evidence/continuity-ops-browser-qa.json` | `verified_local_controlled`、`passed_with_documented_limits`；1265×513 與 360×844 應用程式視窗；Worker SHA-256 `e725a8a8...29cedd` | 目前 artifact 的單一瀏覽器引擎內部本機核對涵蓋深層連結、End／Home／方向鍵分頁切換、瀏覽器前進後退，以及 dialog／手機 drawer 焦點；Axe 4.12.1 在選定規則中為 0 violation、0 incomplete。 | 本輪兩分頁輪詢、完整 WCAG 2.2 AA、人工可及性、真實螢幕閱讀器、跨瀏覽器、真實裝置、遠端或獨立 QA。 |
| CO-VRF-FAILURE-RECOVERY-001 | `evidence/continuity-ops-local-failure-recovery.json` | `verified_local_controlled`；`passed_with_documented_limits`；migration 5,277 ms；恢復後 3/3 個核心讀取通過 | 同一隔離本機 D1 未套 migration 時 health 明確回傳 503；套用 0001→0004 並重啟同一 artifact 後，health、access、overview 恢復。 | runtime bootstrap phases、bootstrap 身分與 fingerprint；網路中斷、部分遠端 D1 故障、應用程式／migration rollback、RTO、RPO 或 production 復原。 |
| CO-VRF-RUNTIME-BOOTSTRAP-001 | `evidence/continuity-ops-local-runtime-bootstrap.json` | `verified_local_controlled`；`passed_with_documented_limits`；3 phases、39／39／33 queries；角色選項 4 個且不含 `admin`；完成 `commander → observer`；Worker SHA-256 `af852b99...27286` | 隔離合成 fresh D1 的三階段初始化、14／20／46 inventory、指定 fingerprint 與 FK 0；並行首次建立只有 1 user／membership／audit；管理員自選拒絕；伺服器權限隨兩次角色切換改變；唯讀角色 5/5 讀取、4/4 method 拒絕、成員目錄 403、稽核 email 省略；其他網域與 suspended 邊界維持 | Sites／production hosted D1 或 identity forwarding、防偽、完整角色 × 事件責任矩陣、admin actor email、Cloudflare production query 計數／方案上限、遠端併行與部分故障、CI、rollback 或發布核准。 |
| CO-VRF-D1-RESTORE-001 | `evidence/continuity-ops-local-d1-restore-drill.json` | `verified_local_controlled`；15 個資料表、4/4 migration、兩端 FK 違反 0；25,751 ms | 隔離合成本機 D1 logical export/import 可還原 0001→0004 結構、逐表筆數與受控 marker。 | runtime bootstrap、產品 artifact、真實資料量、遠端 D1 Time Travel、hosted retention、併行寫入、remote 權限、staging／production、RTO 或 RPO。 |
| CO-VRF-CLEAN-ROOM-001 | `evidence/continuity-ops-clean-room-verification.json` | `verified_local_controlled`、`passed_with_documented_limits`；97 個來源檔；18 個命令 exit 0；API 71/71 | Git 在複製前後均回報選定來源無變更且不含 ignored input；隔離暫存目錄完成 `npm ci`、供應鏈／靜態／測試關卡、建置、runtime bootstrap、migration 與 API smoke。 | 這是本機工作目錄複本，不是獨立 remote clone、另一台主機、CI、bit-for-bit 可重現、staging／production、hosted identity、外部服務／使用者或正式獨立人類 QA。 |
| CO-VRF-MANIFEST-001 | `evidence/continuity-ops-evidence-manifest.json` | `generated_local`；15/15 份預期證據存在；0 failed、0 missing、0 stale current-Worker binding | 盤點目前來源、34 個建置檔、Worker SHA-256 與 15 份證據的雜湊及綁定狀態。 | manifest 先產生再提交，因此記錄的是提交 manifest 前的 clean source commit；這不是 CI、正式部署、發布核准或 artifact provenance 簽章。 |

雜湊縮寫只供閱讀。查核時必須使用 JSON 內完整 64 位 SHA-256。

## 2. 原始碼與測試定義已確認，但結果要另外保存

| 項目 | 可核對位置 | 狀態 | 尚缺的證據 |
|---|---|---|---|
| 角色與事件授權 | `lib/operations-domain.ts`、`lib/operations-auth.ts`、`tests/operations-authorization.test.ts`、`tests/operations-domain.test.ts`、CO-VRF-RUNTIME-BOOTSTRAP-001 | `verified_local`／`verified_local_controlled`：40/40 單元中的授權案例涵蓋精確網域、四個可選角色、管理員排除與唯讀 method 政策；隔離 runtime 另核對 `commander → observer`、伺服器權限變化、5 個唯讀模組、4 個 method 拒絕、成員目錄拒絕及稽核 Email 省略 | 正式身分邊界的實際第二個 NTUB 帳號、完整角色 × 事件責任矩陣、admin actor email 顯示及正式獨立測試。 |
| 組織時區與 DST | `lib/operations-time.ts`、`tests/operations-time.test.ts` | `verified_local`：2.2.0 時區與 DST 單元案例通過 | 跨時區瀏覽器與 API／D1 round-trip 結果。 |
| D1 schema 與 migration | `db/migrations/0001_continuity_ops_v2.sql` 至 `db/migrations/0004_service_lifecycle_accountability.sql`、`tests/operations-migration.test.mjs` | `verified_local`：最終 16/16 migration 案例；另有 4/4 migration 的隔離還原 JSON | 遠端 D1、真實資料量、完整原始測試輸出檔、停機與 rollback。 |
| Fresh-D1 runtime bootstrap 與校內角色選擇 | `db/operations-bootstrap-core.ts`、`db/operations-bootstrap.ts`、`db/operations.ts`、`scripts/run-local-runtime-bootstrap.mjs`、CO-VRF-RUNTIME-BOOTSTRAP-001 | `verified_local_controlled`：三階段 39／39／33 queries；最終 14／20／46 inventory、指定 fingerprint、FK 0、ready 後 3/3；另核對並行首次建立、四種非管理員選項、管理員拒絕、兩次切換、伺服器權限、唯讀限制、資料最小化、其他網域與 suspended | Sites／production hosted D1、正式 identity edge、防偽、平台實際 query 計數與上限、完整角色 × 事件責任矩陣、遠端重試／併行／部分故障及發布後 smoke。 |
| 事件角色相容性 | `lib/operations-domain.ts`、`db/migrations/0003_assignment_role_integrity.sql`、授權與 migration tests | `verified_local`：2.2.0 單元、migration 與指定 Worker API 案例通過 | 完整遠端角色矩陣與遠端 migration 結果。 |
| 服務生命週期理由 | service handler／UI／schema、`db/migrations/0004_service_lifecycle_accountability.sql`、migration／smoke tests、`CO-VRF-BROWSER-001` | `verified_local`：migration 與指定 Worker API 正反例、多頁歷程通過；cursor 單元案例與內部桌面瀏覽器分頁／確認介面通過 | 遠端 API、行動裝置、獨立 QA 與正式 migration 結果。 |
| 公開產品文字、HTML、安全標頭與 Sites artifact 邊界 | `tests/rendered-html.test.mjs`、`worker/index.ts`、CO-VRF-API-001 | `verified_local`：建置後 4/4 通過；包含 Sites artifact 只綁定 D1、不交付 deployment-time SQL migration，本機 root／API 安全標頭也納入 smoke | Sites 實際建置／發布成功、正式 HTTPS edge、圖像 OCR、遠端 CDN 快取與獨立內容查核。 |
| UI 深層連結、手機版、焦點與自動可及性掃描 | `app/operations/OperationsApp.tsx`、`app/globals.css`、`CO-VRF-BROWSER-001` | 目前 Worker 的 `verified_local_controlled`：1265×513、360×844 應用程式視窗、深層連結、End／Home／方向鍵分頁切換、瀏覽器前進後退、dialog／手機 drawer 焦點及 Axe 選定規則已核對 | 本輪兩分頁輪詢、完整 WCAG、真實螢幕閱讀器、跨瀏覽器、真實裝置、正式獨立 QA 與遠端證據。 |
| 秘密掃描與 SBOM | `scripts/scan-repository-secrets.mjs`、`tests/repository-secret-scan.test.mjs`、`scripts/generate-cyclonedx-sbom.mjs`、`evidence/continuity-ops-sbom.cdx.json`、`docs/security-supply-chain.md` | `verified_local`：scanner 案例 5/5、93 個專案文字檔無命中；production audit 0；SBOM 為 `generated_local` | Git history／remote branch／binary／runtime secret scan、通用 entropy 掃描、完整授權結論、SAST、DAST、provenance 與獨立查核。 |
| CI 與供應鏈 | `.github/workflows/ci.yml`、`package-lock.json`、`package.json` | `source_confirmed`；workflow 在子目錄，不會由目前上層 Git root 自動觸發 | 可對回 source commit 的實際 CI run、相依審計結果與建置 digest；目前不是 `verified_ci`。 |

## 3. 目前只有程序或模板

| 項目 | 文件 | 狀態 | 改成已驗證前至少要有什麼 |
|---|---|---|---|
| 獨立整合與端對端 QA | `independent-qa-protocol.md` | `planned_template` | 凍結案例與環境、非功能實作者執行、完整分母、原始 Log、問題處置、修正及相同案例重跑。 |
| 外部專業使用者可靠性 | `external-professional-validation-protocol.md` | `planned_template` | 合格外部使用者、同意紀錄、任務結果、提示／失敗／放棄／重試、Log 對照、重要問題修正及相同任務重測。 |
| 四位組員個人能力 | `personal-evidence-templates.md` | `planned_template` | 逐人說明、實質 commit 區間、決策與驗證，以及未事前看過的診斷演練。 |

本工作目錄在 2026-07-31 的實際本機指令與結果，另見 [`local-verification-record-20260731.md`](local-verification-record-20260731.md)。該紀錄是可重跑的工作紀錄，不是 CI、正式部署或獨立第三方證明。

## 4. 尚未驗證或尚未實作

- 正式環境 private identity edge 與轉送身分 header 防偽。
- 校內角色選擇在 hosted edge 的精確網域、既有使用者／會員停用、四種非管理員角色、管理員排除、完整事件責任組合、admin actor email 與回應欄位矩陣。
- Sites／production hosted D1 的 runtime bootstrap、平台實際 query 計數與方案上限、正式 bootstrap administrator 身分、final inventory／fingerprint 及 ready 後遠端 smoke。
- 外部狀態頁、Email、簡訊或聊天平台整合、失敗處理與送達回執。
- 真實服務健康遙測、告警、Log 收集管線、保存期間與告警規則。
- edge rate limiting、服務生命週期歷程以外清單的 cursor pagination、附件、資料匯出 API。
- 遠端 D1 備份與隔離還原、RTO／RPO、應用程式 rollback 與 migration 回復演練。
- 獨立資安與隱私查核、完整 OWASP ASVS 適用性紀錄、正式 SAST／DAST／滲透測試。
- production 容量、壓力極限、長時間穩定性、寫入負載、SLO 與第三方中斷測試。
- 完整 WCAG 2.2 AA 人工與輔助技術查核。
- 外部專業使用者驗證與修正後重測。
- 乾淨 source commit、可對回的 CI run、非 `unversioned` 部署與具名發布決定。

## 5. 證據失效規則

下列任一項變更時，必須重新判斷受影響證據：需求契約、API 行為、資料表或 trigger、權限、身分邊界、事件狀態、UI 核心流程、依賴、建置設定、migration、測試案例、測試資料、部署環境或外部整合。

文件修訂若只補充說明、不改變產品行為，不會改變既有 Worker artifact；但會讓「完整來源檔清單」過期。任何來源、測試或文件變更後都必須重新判斷受影響證據並重產 manifest。目前瀏覽器證據已綁定最新 Worker；本輪未重跑兩分頁輪詢。clean-room 與 manifest 已依目前文件重跑／重產；後續再修改來源、測試或文件時，兩者即須重新判定。

## 6. 宣稱前檢查

在報告中使用「通過」「完成」「符合」前，逐項確認：

1. 證據是否綁定目前受評版本與環境；
2. 是否保留原始分母、失敗與排除資料；
3. 執行者是否符合獨立性或外部使用者資格；
4. 測試是否真的檢查該主張，而不是只檢查相鄰功能；
5. 修正後是否重跑原失敗情境及相關回歸；
6. 是否仍有會改變結論的限制未揭露。
