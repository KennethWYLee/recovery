# Continuity Ops 本機驗證紀錄：2026-07-31

本文件保存實際執行紀錄，避免把「有測試」誤寫成「測試已通過」。結果只適用於下列本機工作目錄與指定 artifact，不是 CI、staging、production 或獨立第三方驗證。

目前狀態：這是本機候選版檢查點。既有 API、資安、瀏覽器、黑箱、短時負載、受控 Log 與資料庫未就緒後恢復結果綁定舊 Worker digest；新的 fresh-D1 runtime bootstrap 與校內唯讀存取另綁定新 Worker digest。兩組證據不得混用。其他結果各自只支持明列的來源、migration、Log 或本機環境；文件修訂不會把本機結果提升為 CI、遠端、正式獨立或外部證據。

## 1. 執行基準

| 項目 | 記錄值 |
|---|---|
| 執行日期與時區 | 2026-07-31，Asia/Taipei |
| Node.js | `v24.15.0` |
| npm | `11.12.1` |
| Git HEAD | `72151705587c1aa654830955a61454b3e3671aba` |
| 工作目錄 | 有未提交變更；最終證據不是乾淨 commit 的重建結果 |
| 產品／API | `2.2.0` |
| schema | `0004` |
| 既有完整本機證據 Worker | SHA-256 `e725a8a8c1cb9b0b41a1b478e6ad0ca6b11c515d673e051ced27c6c92429cedd` |
| 校內唯讀 runtime-bootstrap Worker | SHA-256 `930199c06dc8297377b5ab937cd5ad4105ff6d17ff6a6c94cd118a874199ac32` |

Git HEAD 只表示目前工作目錄的共同祖先，不代表測試內容已提交。因工作目錄不乾淨，本紀錄不能證明某個 commit 可重建出完全相同結果。

## 2. 當次檢查點結果

| 指令 | 結果 | 此結果能支持什麼 | 此結果不能支持什麼 |
|---|---|---|---|
| `npm run gate:static` | 通過；TypeScript 型別檢查與完整 ESLint 均完成 | 當次工作目錄通過設定中的靜態檢查。 | 執行期正確性、瀏覽器可用性、建置 artifact 或正式部署。 |
| `npm run test:unit` | 39/39 通過 | 授權、精確校內網域、唯讀角色與 method、領域規則、角色相容性、事件篩選、服務生命週期、時間／DST、簽章 cursor、API 輸入邊界與 runtime bootstrap 的現有單元案例通過。 | D1 實際遠端行為、完整使用流程或所有邊界情境。 |
| `npm run test:gherkin` | 10/10 情境、35/35 steps 通過 | 選定的授權、校內寫入拒絕、observer 無指派讀取、證據、服務狀態、未結案篩選與通訊規則具有可讀且可執行的驗收情境。 | 全部需求、API／D1／瀏覽器整合、獨立測試者或外部使用者結果。 |
| `npm run test:gherkin:fault-injection` | 6/6 個手工設計規則故障被對應情境抓到；0 survived | Gherkin 情境可辨識六項選定規則被弱化。 | 不是完整 mutation campaign 或 mutation score，不涵蓋所有需求；同一 repository 內執行，不是獨立人類 QA。 |
| `npm run test:quality` | coverage 門檻通過；line 92.05%、branch 85.43%、function 93.91%；5 個複雜度診斷項目；CRAP 未計算 | 指定六個單元測試套件與六個 source 的整體 coverage，以及複雜度超過 15 的檢視位置。 | 測試斷言品質、未納入的 Worker／UI／migration、功能正確性、資安或發布準備度。 |
| `npm run test:migration:sql` | 最終 16/16 通過 | 空白資料庫、legacy 升級、0001→0004、角色相容性、服務生命週期、資料不變條件與重試均通過；另核對 Sites 的 214 個 SQL 區段可逐一以單一 prepared statement 執行。 | 遠端 D1、真實資料量、正式環境權限、停機時間或 rollback。 |
| `npm run test:migration:wrangler` | Wrangler 依序套用 0001–0004 | 目前 migration 集可套用到隔離本機 D1。 | 遠端 D1、正式資料、停機或 rollback。 |
| `npm run test:tools` | 14/14 通過 | telemetry 分析器、隔離 D1 還原工具與 repository secret scanner 的 known-good／known-bad 案例通過。 | 生產 Log、遠端備份、告警、RTO、RPO、未知秘密格式或產品 artifact 可還原。 |
| `npm run build`、`npm run test:integration` | 建置通過；4/4 整合案例通過 | 最終 Worker artifact 可建置；可部署文字檔不含 prompt、評分、課程、學生文件或舊產品語境，Sites artifact 也不交付 deployment-time SQL migration。 | 正式部署、遠端標頭、圖像 OCR 或 production 快取。 |
| `npm run test:smoke` | 71/71 通過；27 正向、44 負向；所有觀察到的請求均無非預期 5xx | 最終 Worker 搭配隔離本機 D1 的指定 API 流程、同時冪等請求、同版本競爭更新、安全標頭、輸入攻擊形狀與拒絕案例通過。 | hosted edge、正式身分邊界、production 容量、外部送達、外部使用者或正式資安結論。 |
| `npm run test:blackbox:local` | 12/12 通過；`verified_local_agent_designed` | 未參與功能實作的 agent 依事前凍結案例，從公開 HTTP 介面核對選定的正確輸入、錯誤輸入與資料不變條件。 | 正式 G7、外部人員、委託第三方、遠端端對端或外部使用證據。 |
| `npm run test:load:local` | 590/590 有效回應；最高同時 50；0 個 5xx | 短時、唯讀、本機合成資料負載下，所列路徑維持回應格式與 request ID。 | production 容量、壓力極限、soak、寫入負載、SLO、rate limiting 或遠端網路。 |
| 內部交互式瀏覽器與 Axe 核對 | 通過；1265×513 與 360×844 應用程式視窗；Axe 4.12.1 在選定規則中 0 violation、0 incomplete | 同一 Worker 在單一引擎核對深層連結、End／Home／方向鍵分頁切換、瀏覽器前進後退，以及 dialog／手機 drawer 的焦點回復。 | 本輪未重跑兩分頁輪詢；也不能支持完整 WCAG 2.2 AA、人工可及性、真實螢幕閱讀器、跨瀏覽器、真實裝置、遠端或正式獨立 QA。 |
| `npm run test:failure-recovery:local` | 通過；未套 migration 時 health 為 503；migration 5,277 ms；恢復後 3/3 個核心讀取通過 | 同一隔離本機 D1 套用 0001–0004 並重啟相同 artifact 後，health、access、overview 恢復。 | 網路中斷、部分遠端 D1 故障、應用程式或 migration rollback、RTO、RPO 或 production 復原。 |
| `npm run test:runtime-bootstrap:local` | 通過；3 phases、39／39／33 queries；校內唯讀 5/5 讀取、4/4 狀態變更 method 拒絕 | 隔離本機 Worker／合成 D1 下，兩個同時校內首次請求只建立 1 user／1 membership／1 audit；當次角色為 `auditor`；成員目錄 403、audit actor email 省略；既有 admin 保留，其他網域未受邀者與 1 筆 suspended 會員為 403。 | Hosted identity edge 防偽、Sites／production、所有身分／角色組合、admin actor email 顯示或完整存取政策。 |
| `npm run test:fault-injection` | 18/18 目標故障被偵測；0 survived | 現有測試可辨識 18 個風險導向的領域、授權、輸入、時間與 cursor 規則弱化。 | 完整 mutation testing、所有規則的判別力或真實故障復原。 |
| `npm run gate:supply-chain` 的 scanner 檢查 | scanner 案例 5/5；93 個文字檔無命中 | 指定範圍的專案文字來源沒有命中 scanner 支援的憑證格式。 | Git history、remote branch、binary、runtime secret、未知格式、SAST、DAST 或獨立資安查核。 |
| `npm run audit:production` | production dependencies 0 個已知弱點 | 當次 lockfile 與 npm advisory 資料下，production 相依套件未回報弱點。 | 未來 advisory、SAST、DAST、供應鏈 provenance、授權查核或零時差弱點。 |
| `npm run test:clean-room` | 通過；97 個來源檔、18 個命令 exit 0、API 71/71 | Git 在複製前後均回報選定來源無變更且不含 ignored input；隔離暫存目錄完成安裝、關卡、建置、runtime bootstrap、migration 與 smoke。 | 不是獨立 remote clone、另一台主機、CI、bit-for-bit 可重現、staging／production 或正式獨立人類 QA。 |

## 3. 保留失敗，不改寫歷史

`npm run test:migration:sql` 先前第一次執行為 13/15。當時新增 `ops_service_lifecycle_events` 後，資料表清單的舊測試預期尚未同步；更新測試預期並加入生命週期資料表查核後為 15/15。本次部署又新增 Sites migration 分段契約，確認 214 個頂層 SQL 敘述不會切斷 trigger，最終為 16/16。

這次失敗與修正說明的是測試與 schema 必須一起維護。它不代表正式 migration 已演練，也不應從紀錄中刪除。

遙測分析第一次執行時有 7/363 筆被判定無效。原因不是原始 Log 格式錯誤，而是分析器的 `SAFE_ROUTES` 未登錄服務生命週期歷程 route template。補上允許的 template 並增加對應測試後，以同一份 Log 重跑為 399/399 筆通過；本次部署前重新執行 API、黑箱、負載與瀏覽器流程後，最終證據為 815/815 筆有效，其中 761 筆成功、54 筆受控 4xx、0 筆 5xx；安全負向檢查的 request ID 對應為 44/44，API、schema 與 deployment mismatch 均為 0。這只驗證受控本機 Log 與分析器契約，不代表正式收集、保存或告警已完成。

較早的 oversized body 案例曾在本機 proxy 失敗，無法證明應用程式會自行拒絕。修正後改為串流讀取、超限時取消並排空請求，且不信任 `Content-Length`；應用程式限制固定為 32 KiB。同一案例重跑取得 413，最新完整 API smoke 為 71/71。這是本機 Worker preview 的結果，不代表 hosted edge 已驗證。

重新建置時，vinext 會產生新的 build ID 與 draft-mode secret，因此同一來源的 Worker digest 可能改變。本紀錄不主張 bit-for-bit reproducible build；既有完整檢查與新的校內唯讀 runtime-bootstrap 分屬兩個明列的完整 SHA-256，不能互相補足。舊 clean-room 與 manifest 也不能自動延伸到修改後來源。要主張可重現建置，仍須在獨立 remote clone 與已記錄的 CI 環境控制建置輸入並比較結果。

## 4. 同次操作證據

- `CO-VRF-D1-RESTORE-001`：`verified_local_controlled`。來源與還原端各 15 個資料表，逐表筆數相同；4/4 migration history、marker 1/1、兩端 foreign key 違反 0；總耗時 25,751 ms。這是合成本機 logical export/import，不是 RTO。
- `CO-VRF-TELEMETRY-001`：`verified_local_controlled`，結果為 `passed`。最終受驗 Log 為 815/815 筆符合欄位契約，其中 761 筆成功、54 筆受控 4xx、5xx 為 0；安全負向檢查的 request ID 對應為 44/44，API、schema 與 deployment version 均一致。正式 ingestion、retention、sampling 與告警仍未驗證。
- `CO-VRF-BROWSER-001`：`verified_local_controlled`，結果為 `passed_with_documented_limits`。它支持最終 Worker 在單一瀏覽器引擎的桌面與窄螢幕指定流程，以及 Axe 選定規則掃描；不是完整 WCAG、真實螢幕閱讀器、跨瀏覽器、正式獨立 QA 或遠端驗證。
- `CO-VRF-QA-BLACKBOX-001`：`verified_local_agent_designed`，12/12 通過。它是未參與功能實作的 agent 執行的本機前置黑箱查核，不是正式 G7 或外部第三方證據。
- `CO-VRF-LOAD-001`：`verified_local_controlled`，590/590 有效、最高同時 50、0 個 5xx。這是短時唯讀 smoke，不是 production 容量或 SLO 結論。
- `CO-VRF-FAILURE-RECOVERY-001`：`verified_local_controlled`。本機未套 migration 時正確失敗，套用 migration 後恢復 3 個核心讀取；不是 rollback、RTO 或 RPO。
- `CO-VRF-RUNTIME-BOOTSTRAP-001`：`verified_local_controlled`。除三階段 fresh-D1 bootstrap 外，本次涵蓋一個隨機校內唯讀角色的 5 個讀取模組、4 個狀態變更 method 拒絕、並行首次建立、成員目錄拒絕、audit actor email 省略、既有 admin、其他網域未受邀者及一筆 suspended 會員；不是 hosted identity edge、production 或完整權限矩陣。
- `CO-VRF-CLEAN-ROOM-001`：97 個來源檔、18 個命令 exit 0、API 71/71。Git 在複製前後均回報選定來源無變更且不含 ignored input；本機合成 D1／身分及自動內部執行仍不等於獨立 remote clone、另一台主機、CI、hosted identity、外部服務、外部使用者或正式獨立人類 QA。

完整資料、分母、雜湊與限制以 `evidence/` 內各項對應 JSON 為準；本文只整理主要結果，不取代原始證據。

## 5. 尚未執行

本次紀錄沒有執行或證明下列事項：

- 從獨立 remote clone 或另一台主機進行 bit-for-bit 可重現建置；本次 clean-room 只驗證 Git 判定乾淨的本機來源複本，不能支持這項主張。
- 完整 WCAG 2.2 AA 人工查核、真實螢幕閱讀器、跨瀏覽器與真實行動裝置查核。
- SAST、DAST、滲透測試、production 容量、壓力極限、寫入負載、SLO 或長時間穩定性測試。
- hosted preview、staging、production 部署，以及正式身分邊界、遠端 D1、監控告警、備份與回復；本文只有本機 Worker preview。
- G7 獨立 QA、G8 外部專業使用者驗證或 P1-P4 四位組員現場能力查核。

以上事項完成前，不能僅憑本文件宣稱系統已達生產等級或所有評分項目滿分。
