# Continuity Ops 證據狀態登錄

盤點日期：2026-07-31  
用途：明確區分已執行結果、原始碼設計、產生的清單、待執行程序與尚未驗證事項。

目前原始碼基準為產品/API `2.2.0`、schema `0004`。最終受驗 Worker SHA-256 為 `1d8b2d0c99000fb1d6b58b23de97adadba06210f370ddcb03e41c95468cf9158`。API、資安負例、可執行 Gherkin、Gherkin 規則故障注入、單元測試與品質指標、風險導向故障注入、受控 Log、本機瀏覽器、agent 設計的黑箱查核、短時讀取負載、資料庫未就緒後恢復、D1 還原，以及 clean-room 隔離快照驗證已有本機結果；各結果只支持明列的 artifact、來源、Log、migration 或本機環境。最終 manifest 應由目前來源與建置重新產生；所有本機結果都不能改寫為 CI、staging、production、正式獨立 QA 或外部使用證據。

本系統以獨立 repository 發布，`.github/workflows/ci.yml` 位於 Git root。每次 `main` push 或 pull request 都會執行關卡；只有保存成功 run ID、source commit 與 artifact digest 後，才可把結果列為 `verified_ci`。

## 1. 現有可核對檔案

| 證據 | 檔案 | 記載的狀態 | 可支持的主張 | 不能支持的主張 |
|---|---|---|---|---|
| CO-VRF-API-001 | `evidence/continuity-ops-api-smoke.json` | `verified_local`；71/71，27 正向、44 負向；0 個非預期 5xx；Worker SHA-256 `1d8b2d0c...cf9158` | 指定 2.2.0 本機 Worker 與隔離 D1 的 API 核心流程、拒絕情境、資料 round-trip、同時冪等請求、同版本競爭更新、安全標頭、生命週期多頁查詢與稽核結果。 | 正式部署、真實身分邊界、hosted edge、外部送達、外部使用者、正式容量或獨立資安查核。 |
| CO-VRF-SEC-001 | `evidence/continuity-ops-security-negative-tests.json` | `verified_local`；44 項負例，`passed_with_documented_limits`；綁定同一 Worker digest | 指定本機 artifact 對列出的授權、狀態、版本、輸入、證據、內容型別、大小限制與資料不變條件負例。 | 正式身分 edge、完整 SAST／DAST／滲透測試、所有 OWASP ASVS 控制或正式環境資安結論。 |
| CO-VRF-GHERKIN-001 | `evidence/continuity-ops-gherkin-acceptance.json` | `verified_local`；1 個 feature、8 個情境、28/28 steps 通過 | 以可讀且可執行的情境核對選定的授權、證據、服務狀態、未結案篩選與通訊規則。 | 全部需求、API／D1／瀏覽器整合、獨立測試者或外部使用者結果。 |
| CO-VRF-GHERKIN-FAULT-001 | `evidence/continuity-ops-gherkin-fault-injection.json` | `verified_local`；`passed`；6/6 個手工設計規則故障被對應情境抓到，0 survived | 六項風險導向弱化分別涵蓋事件轉換授權、角色相容性、HTTPS 工作證據、淘汰服務、未結案篩選與最終通訊標記。 | 只涵蓋目前 8 個情境中的六項風險；不是完整 mutation campaign 或 mutation score，不代表所有需求，也不是獨立人類 QA。 |
| CO-VRF-QUALITY-001 | `evidence/continuity-ops-quality-metrics.json` | `verified_local`；29/29 單元測試；line 95.38%、branch 82.47%、function 87.88%；4 個複雜度診斷項目；CRAP 未計算 | 指定五個單元測試套件及五個 library source 的整體 coverage 門檻與複雜度診斷。 | 斷言品質、Worker／UI／migration coverage、功能正確性、資安、可用性或發布準備度。 |
| CO-VRF-FAULT-001 | `evidence/continuity-ops-fault-injection.json` | `verified_local`；18/18 個指定故障被既有測試抓到，0 survived | 既有測試可辨識 18 個風險導向的領域、授權、輸入、時間與 cursor 規則弱化。 | 完整 mutation testing、所有規則的判別力或真實故障復原。 |
| CO-VRF-QA-BLACKBOX-001 | `evidence/continuity-ops-independent-blackbox-qa.json` | `verified_local_agent_designed`；12/12 通過；綁定同一 Worker digest | 未參與功能實作的 agent 依事前凍結案例，從公開 HTTP 介面核對 known-good、known-bad、身分 header、版本衝突與資料一致性。 | 正式 G7、外部人員、委託第三方、遠端環境、完整端對端或外部使用證據。 |
| CO-VRF-LOAD-001 | `evidence/continuity-ops-local-load-smoke.json` | `verified_local_controlled`；590/590 有效回應；最高同時 50；0 個 5xx | 短時、唯讀、本機合成資料負載下，所列路徑維持回應格式、request ID 與非 5xx。 | production 容量、壓力極限、長時間穩定性、寫入競爭、SLO、rate limiting 或遠端網路。 |
| CO-VRF-TELEMETRY-001 | `evidence/continuity-ops-request-telemetry-analysis.json` | `verified_local_controlled`、`passed`；879/879 筆有效；51 筆預期 4xx、0 筆 5xx；API／schema／deployment version 一致 | 最終受驗本機 Wrangler Log 的欄位白名單、明確分母、問題代碼、狀態與版本一致性。 | 正式 ingestion、retention、sampling、告警、production 負載延遲或生產可觀測性。 |
| CO-VRF-BROWSER-001 | `evidence/continuity-ops-browser-qa.json` | `verified_local_controlled`、`passed_with_documented_limits`；1280×720 與 320×568；綁定同一 Worker digest | 單一瀏覽器引擎的內部本機核對涵蓋鍵盤 tabs、modal 焦點回復、手機 drawer、深層連結、前進後退、兩分頁輪詢由 38 更新為 39；Axe 4.12.1 在選定規則中為 0 violation、0 incomplete。 | 完整 WCAG 2.2 AA、人工可及性、真實螢幕閱讀器、跨瀏覽器、真實裝置、遠端或獨立 QA。 |
| CO-VRF-FAILURE-RECOVERY-001 | `evidence/continuity-ops-local-failure-recovery.json` | `verified_local_controlled`；`passed_with_documented_limits`；migration 5,441 ms；恢復後 3 個核心讀取通過 | 同一隔離本機 D1 未套 migration 時 health 明確回傳 503；套用 0001→0004 並重啟同一 artifact 後，health、access、overview 恢復。 | 網路中斷、部分遠端 D1 故障、應用程式／migration rollback、RTO、RPO 或 production 復原。 |
| CO-VRF-D1-RESTORE-001 | `evidence/continuity-ops-local-d1-restore-drill.json` | `verified_local_controlled`；15 個資料表、4/4 migration、兩端 FK 違反 0；26,273 ms | 隔離合成本機 D1 logical export/import 可還原 0001→0004 結構、逐表筆數與受控 marker。 | 產品 artifact、真實資料量、遠端 D1 Time Travel、hosted retention、併行寫入、remote 權限、staging／production、RTO 或 RPO。 |
| CO-VRF-CLEAN-ROOM-001 | `evidence/continuity-ops-clean-room-verification.json` | `verified_local_controlled`；`passed_with_documented_limits`；93 個來源快照檔、17 個命令 exit 0、API 71/71 | 來源快照在隔離暫存目錄完成 `npm ci`、關卡、建置、migration 與 API smoke；該次來源、Worker SHA-256 及耗時記錄於證據 JSON。 | 來源是目前未提交工作目錄的複本，不是 clean Git checkout、CI 或 commit-bound release；vinext digest 不證明 bit-for-bit 可重現；本機合成 D1／身分不含 staging、production、hosted identity、外部服務或使用者；自動內部執行不是正式獨立人類 QA。 |
| CO-VRF-MANIFEST-001 | `evidence/continuity-ops-evidence-manifest.json` | `generated_local`；14/14 份預期證據存在，0 失敗、0 缺件、0 份目前 Worker 綁定過期 | 盤點最終來源、建置 artifact 與證據檔，並核對應綁定目前 Worker 的證據。 | manifest 來自有未提交變更的工作目錄；清單本身不能證明 clean commit、CI、正式部署或發布核准。 |

雜湊縮寫只供閱讀。查核時必須使用 JSON 內完整 64 位 SHA-256。

## 2. 原始碼與測試定義已確認，但結果要另外保存

| 項目 | 可核對位置 | 狀態 | 尚缺的證據 |
|---|---|---|---|
| 角色與事件授權 | `lib/operations-domain.ts`、`lib/operations-auth.ts`、`tests/operations-authorization.test.ts`、`tests/operations-domain.test.ts` | `verified_local`：29/29 單元案例、Gherkin 選定情境、18/18 故障注入與指定 Worker API 正反例通過 | 正式身分邊界、完整遠端角色矩陣及正式獨立測試。 |
| 組織時區與 DST | `lib/operations-time.ts`、`tests/operations-time.test.ts` | `verified_local`：2.2.0 時區與 DST 單元案例通過 | 跨時區瀏覽器與 API／D1 round-trip 結果。 |
| D1 schema 與 migration | `drizzle/0001_continuity_ops_v2.sql` 至 `drizzle/0004_service_lifecycle_accountability.sql`、`tests/operations-migration.test.mjs` | `verified_local`：最終 16/16 migration 案例；另有 4/4 migration 的隔離還原 JSON | 遠端 D1、真實資料量、完整原始測試輸出檔、停機與 rollback。 |
| 事件角色相容性 | `lib/operations-domain.ts`、`drizzle/0003_assignment_role_integrity.sql`、授權與 migration tests | `verified_local`：2.2.0 單元、migration 與指定 Worker API 案例通過 | 完整遠端角色矩陣與遠端 migration 結果。 |
| 服務生命週期理由 | service handler／UI／schema、`drizzle/0004_service_lifecycle_accountability.sql`、migration／smoke tests、`CO-VRF-BROWSER-001` | `verified_local`：migration 與指定 Worker API 正反例、多頁歷程通過；cursor 單元案例與內部桌面瀏覽器分頁／確認介面通過 | 遠端 API、行動裝置、獨立 QA 與正式 migration 結果。 |
| 公開產品文字、HTML 與安全標頭 | `tests/rendered-html.test.mjs`、`worker/index.ts`、CO-VRF-API-001 | `verified_local`：建置後 3/3 通過；本機 root／API 安全標頭也納入 smoke | 正式 HTTPS edge、圖像 OCR、遠端 CDN 快取與獨立內容查核。 |
| UI 深層連結、手機版、焦點與自動可及性掃描 | `app/operations/OperationsApp.tsx`、`app/globals.css`、`CO-VRF-BROWSER-001` | `verified_local_controlled`：1280×720、320×568、鍵盤 tabs、modal 焦點、手機 drawer、前進後退、兩分頁輪詢及 Axe 選定規則已核對 | 完整 WCAG、真實螢幕閱讀器、跨瀏覽器、真實裝置、正式獨立 QA 與遠端證據。 |
| 秘密掃描與 SBOM | `scripts/scan-repository-secrets.mjs`、`tests/repository-secret-scan.test.mjs`、`scripts/generate-cyclonedx-sbom.mjs`、`evidence/continuity-ops-sbom.cdx.json`、`docs/security-supply-chain.md` | `verified_local`：scanner 案例 5/5、88 個專案文字檔無命中；production audit 0；SBOM 為 `generated_local` | Git history／remote branch／binary／runtime secret scan、通用 entropy 掃描、完整授權結論、SAST、DAST、provenance 與獨立查核。 |
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

文件修訂若只補充說明、不改變產品行為，不會改變既有 Worker artifact；但會讓「完整來源檔清單」過期。因此現有 API smoke 仍只代表它記載的 Worker SHA-256；任何來源、測試或文件變更後都必須再次重產 manifest。本次 manifest 已在最新測試與文件定稿後重新生成。

## 6. 宣稱前檢查

在報告中使用「通過」「完成」「符合」前，逐項確認：

1. 證據是否綁定目前受評版本與環境；
2. 是否保留原始分母、失敗與排除資料；
3. 執行者是否符合獨立性或外部使用者資格；
4. 測試是否真的檢查該主張，而不是只檢查相鄰功能；
5. 修正後是否重跑原失敗情境及相關回歸；
6. 是否仍有會改變結論的限制未揭露。
