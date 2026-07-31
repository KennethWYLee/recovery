# Continuity Ops 驗證與發布計畫

狀態：`proposed`。本文定義關卡與證據要求；已完成的本機結果另見 [2026-07-31 本機驗證紀錄](local-verification-record-20260731.md)。本機結果不表示 staging、正式獨立 QA、外部使用、獨立資安查核或正式發布已執行。

介面與互動的預期行為見 [產品設計基準](../product-design.md)。該文件只能作為受驗契約來源，不能代替實際測試結果。

## 1. 凍結受驗對象

每次候選版必須固定：

- source commit 與工作目錄狀態；
- Node.js 版本、lockfile 與建置指令；
- migration 集合與資料契約版本；
- 受驗環境、設定名稱及不含真值的秘密變數清單；
- `CONTINUITY_OPS_DEPLOYMENT_VERSION`、API version、schema version 與預期 artifact 的對應；
- 測試資料、原始分母、排除規則與預期結果；
- artifact digest 與 CI run ID。

任何程式、migration、測試、設定或文件變更後，受影響的驗證結果立即過期。

## 2. CI 基本關卡

| 關卡 | 指令 | 要抓到的失敗 | 最低輸出 |
|---|---|---|---|
| 鎖定相依 | `npm ci` | package 與 lockfile 不一致、無法重建依賴 | Node/npm 版本與 install 結果 |
| 生產相依審計 | `npm run audit:production` | 達停止門檻的已知弱點 | audit 時間、資料源與結果 |
| 靜態檢查 | `npm run gate:static` | 型別、Lint 與明確編碼錯誤 | 指令、exit code 與 Log |
| 規則與授權 | `npm run test:unit` | 事件狀態、角色、資源關係、輸入與版本邊界錯誤 | 案例數、失敗案例與測試版本 |
| 可執行驗收情境 | `npm run test:gherkin` | 文件中的選定情境與實際規則不一致 | feature、scenario、step 分母及失敗位置 |
| Gherkin 情境判別力 | `npm run test:gherkin:fault-injection` | 選定規則被弱化後，對應情境仍然通過 | 手工設計故障、對應情境、預期失敗與 survived 分母 |
| Coverage 與複雜度診斷 | `npm run test:quality` | 整體 coverage 低於門檻；高複雜度位置未被看見 | line／branch／function 分母、門檻及診斷項目；無可靠資料時不計算 CRAP |
| Migration | `npm run test:migration` | 空白庫建立失敗、constraint／index／trigger 缺漏 | migration 集合與 schema 查核結果 |
| 證據工具 | `npm run test:tools` | telemetry、還原或秘密掃描工具無法辨識 known-bad | 工具案例分母與失敗案例 |
| 測試判別力 | `npm run test:fault-injection` | 重要規則被破壞後測試仍然通過 | baseline、mutant、預期失敗與還原回歸 |
| 生產建置 | `npm run build` | 實際 bundle、Worker 或資源包裝失敗 | artifact、bytes、digest 與建置 Log |
| 建置後整合 | `npm run test:integration` | 產品 metadata、路由、安全標頭或包裝結果與來源不一致 | 測試結果及 artifact digest |

CI 僅產生待審的建置產物，不自動部署生產環境。

需要執行中的 Worker 或隔離狀態的 `test:blackbox:local`、`test:load:local`、`test:failure-recovery:local` 與 `test:clean-room` 應另外保存環境、artifact digest、完整分母與限制。四項均有本機結果；clean-room 對 Git 判定無變更且不含 ignored input 的 97 個來源檔執行 18 個命令，均 exit 0，API 71/71。這仍是本機複本，不能改寫成獨立 remote clone、CI、bit-for-bit 可重現或正式發布證據。

目前 6/6 個手工設計的 Gherkin 規則故障被對應情境抓到，0 survived。這只檢查目前 8 個情境中的六項風險，不是完整 mutation campaign 或 mutation score，也不代表所有需求或正式獨立人類 QA。

## 3. 目前實作契約的必要反例

候選版至少要以 API 與資料庫層級檢查下列行為；前端按鈕被停用不能代替伺服器證據：

- `monitoring → resolved` 在缺少復原判定條件、缺少進入本次 monitoring 後的 verification，或仍有未完成 critical 工作時，分別以穩定問題代碼拒絕。重新進入 investigating、再次 monitoring 後，舊週期 verification 不得通過。
- verification 接受合法 HTTPS reference、source label、觀測時間窗與 SHA-256 digest，並拒絕非 HTTPS、起訖顛倒及格式錯誤 digest；報告必須註明系統沒有讀取原始 Log 或驗證外部內容。
- 非完成狀態可接受空值；`completed` 必須拒絕空值、HTTP、缺少主機名稱及格式錯誤的網址，接受合法 HTTPS 網址，並拒絕從已完成工作移除必要證據。測試與報告必須註明系統不擷取或驗證外部內容，且工作完成狀態不是成果正確的充分證據。
- `critical` 工作改為 `cancelled` 時必須拒絕空白、過短、過長或前後帶空白的理由；同一更新將 priority 降級再取消也必須拒絕。合法理由保存後，即使工作再降級也不得移除或改寫。
- 通訊建立時只能是 draft，只有 draft 可編輯或核准，只有 reviewed 可標記為 published。核准與標記發布必須是分開操作；stale version、核准後改寫內容、已發布後更新／刪除及終止事件標記發布都必須被拒絕。
- 利害關係人與公開通訊在 `draft → reviewed` 時缺少未來 `nextUpdateAt` 必須被拒絕；`reviewed → published` 時排程已過期也必須被拒絕。最終公告可免排程，但必須從第一個字元使用大小寫不拘的獨立 `[FINAL]` 標記，且標記後是空白或訊息結束。測試報告必須將 published 說明為系統內狀態，不能寫成外部狀態頁、Email 或訊息平台已傳送或送達。
- 事後檢討在未解決事件被拒絕；draft 可不完整、completed 必須填妥六段；stale expectedVersion 被拒絕；重新開啟會將 completed 原子改回 draft、增加 version 並留下 timeline／audit。
- service slug 不可變；active／deprecated 更新使用 expectedVersion；仍有未結案事件時不得 deprecated；每次淘汰或重新啟用都要有專用確認、8–1000 字非空白原因、合格的啟用中 admin／commander、request ID 與 UTC 時間，並新增不可更新或刪除的生命週期歷程。只有換行、歸位、tab、vertical tab、form feed 或 NBSP 的原因必須被拒絕；重新啟用保留既有歷史，舊淘汰資料不得補造不存在的理由。`service_owner` 事件角色不得因此取得 `service:write`。
- 指派撤銷保留 revoked row、ended time 與 actor；最後一位事件指揮官沒有接任者時被拒絕；有合格接任者時，新指派、原指派撤銷、timeline 與 audit 必須同批完成。
- 最後一位啟用中 admin 不得被停用或降級；仍為未結案事件唯一指揮官的成員，不得在交接前失去合格組織角色。成員更新必須使用 `expectedVersion`；兩位管理者並行變更時，過期版本必須得到 409 而非覆寫新狀態。
- 未知或未受邀的已驗證身分不得自動建立成員資格；無效身分不得使用未驗證 header 建立 actor 稽核。
- 每個 mutation 都要求有效 Idempotency-Key。相同 scope／actor／key／payload 重播相同回應；不同 payload 使用相同 key 被拒絕；過期回執不重播，且有界清理不得刪除未過期或其他組織資料。
- request telemetry 必須是可解析 JSON，使用不含資源 ID 的 route template，且有 request ID、method、status、problem code、latency、API／schema／deployment version。不得出現 request body、token、cookie、authorization header 或使用者提供的自由文字。
- 沒有服務遙測來源時，service health 必須維持 unknown、unavailable、sample size 0 與 null SLO attainment，不得依零事件推論 operational。
- 瀏覽器測試必須確認 `view`、`incident` 與 `tab` 可由網址還原，前進、後退能更新畫面，無權查看的 view 或 incident 不會因深層連結而取得資料。
- 畫面可見且沒有寫入進行時，瀏覽器測試必須確認選取事件的明細、時間軸與通訊會在 8 秒輪詢週期更新，總覽使用 30 秒週期，頁面重新可見時會立即更新事件明細。測試不得把輪詢描述成即時推播。
- 事件狀態變更、角色撤銷與交接、工作完成或取消、成員降權或停用、服務淘汰／重新啟用，以及通訊核准與標記發布必須顯示確認、風險提示或理由後才送出。瀏覽器案例須驗證生命週期確認未勾選、原因缺漏或不合格時不送出；任何介面檢查都不得取代 API 與資料庫負例。
- 組織時區必須由 D1 round-trip 至 API；正常地方時間要正確轉成 UTC instant，設定缺漏或無效時採 UTC，DST 中不存在或重複的地方時間必須被拒絕。瀏覽器仍須驗證跨時區輸入與顯示一致。
- Migration 測試必須同時涵蓋空白資料庫的 `0001 → 0002 → 0003 → 0004`、實際早期 `0001` 結構的向前升級、`0003` 對既有不相容啟用中指派的停止條件，以及 `0004` 對空白變形、操作者、request ID、逐次歷程、不可改寫與 legacy 淘汰資料重新啟用的處理；執行 `foreign_key_check`，核對 SQL migration 與 Drizzle 的 service／organization 複合外鍵，並確認 migration 不捏造完成證據、取消理由、事後檢討內容、角色交接或服務生命週期理由。

## 4. Staging 整合與獨立 QA

本機已有 12/12 的 agent 設計黑箱前置查核、71/71 API smoke、590/590 短時唯讀負載及內部瀏覽器流程。這些結果可在進入 staging 前發現問題，但執行者、環境與目的都不符合本節的正式獨立 QA，因此下列要求不變。

1. 從新建立的 staging 環境套用 migration。
2. 使用平台已驗證身分，執行服務建立／更新／淘汰、事件建立、角色指派／撤銷／交接、調查、處置、工作與完成證據、通訊草稿／核准／標記發布、具欄位約束的驗證證據、三門檻解決、重新開啟及事後檢討草稿／完成。
3. 驗證未授權角色、他人資源、stale version、重複或錯誤重用 Idempotency-Key、資源關係不合與過長輸入均被伺服器拒絕。
4. 由非原實作者使用事前凍結案例執行主要流程及失敗情境。
5. 以 known-good 與 known-bad 輸入檢查測試 harness 本身。
6. 從平台 request telemetry 確認 deployment version 與 artifact 對應且不是 `unversioned`，並驗證未知服務遙測不被顯示為正常。
7. 以兩個獨立瀏覽器工作階段確認事件更新可在預定輪詢週期內出現，切回可見頁面會更新資料，深層連結與前進／後退不會繞過授權。記錄實際觀察時間，不以「即時」概括。
8. 確認通訊標記為 published 後沒有外部傳送動作或送達回執；除非日後另行實作並驗證整合，不得把內部狀態寫成外部送達。
9. 記錄執行者、環境、開始／結束時間、結果、原始 Log 位置與未解決限制。

## 5. 安全與可及性驗證

- 依 [`../security-model.md`](../security-model.md) 的信任邊界與權限矩陣設計負例。
- 以 OWASP ASVS 5.0.0 的固定版本 requirement ID 建立適用、不適用、已驗證與待驗證清單。
- 執行依賴審計、秘密掃描、靜態安全分析、授權負例及相稱的獨立安全查核。
- 在實際 private identity edge 驗證外部請求不能偽造受信任身分 header，未知身分不會自動受邀，最後一位管理員與事件指揮交接 guard 會 fail closed。
- 驗證深層連結的查詢參數不接受秘密或權限資訊，無效 view／incident／tab 不會繞過伺服器身分、組織與資源授權。
- 查核所有高風險操作的介面確認範圍，但仍以 API 權限、狀態、版本與資料庫負例作為必要安全證據。
- 驗證 Worker 安全標頭在遠端回應生效，並追蹤目前 inline script/style 相容設定改為 CSP nonce／hash 的剩餘工作。
- 以 WCAG 2.2 AA 為目標，執行鍵盤、焦點、語意、狀態非單靠顏色、對比與螢幕閱讀器人工檢查。

目前本機單一瀏覽器引擎已在 1265×513 與 360×844 應用程式視窗核對深層連結、End／Home／方向鍵分頁切換、瀏覽器前進後退，以及 dialog／手機 drawer 焦點；Axe 4.12.1 對選定規則回報 0 violation、0 incomplete。本輪未重跑兩分頁輪詢。這是自動前置檢查，不等於完整 WCAG 2.2 AA。尚未完成全頁、全流程、人工判斷、真實螢幕閱讀器與跨瀏覽器檢查前，不宣稱 WCAG 2.2 AA 符合性。

## 6. 復原與回復演練

本機前置結果已確認兩件事：未套 migration 的隔離 D1 會讓 health 明確回傳 503，套用 0001–0004 並重啟後 3/3 個核心讀取恢復；另有 15 個資料表、4/4 migration 的 logical export/import 查核。5,277 ms 的 migration 與 25,751 ms 的本機還原耗時只是觀察值，不是 RTO 或 RPO。

- 定義並核准 RTO、RPO 及可接受的資料遺失範圍。
- 取得 D1 備份，在隔離環境完成還原與資料一致性查核。
- 執行應用程式 rollback、migration 不相容處理、中止發布及重新前進的演練。
- 記錄實際耗時、手動步驟、未成功檢查及改善項目。

## 7. 外部使用可靠性

外部驗證必須找到符合產品目標的 IT 維運、SRE、資安應變、服務負責或事件指揮人員，不得以內部實作者、自動 smoke 或合成資料代替。

事前固定招募條件、核心任務、完成定義、允許提示、排除規則、版本與環境。報告至少包含邀請 N、開始 N、完成 N、有效 n、排除理由、未經提示的完成／失敗／放棄／重試、錯誤步驟、時間、意見及 Log 交叉分析。

妨礙核心任務或造成資安／資料風險的問題必須修正，再以相同任務、相同量測定義與可比的外部使用者條件重測，同時執行相關回歸。

## 8. 發布停止條件

出現下列任一情況時不得發布：

- 受驗 source commit、artifact digest、migration 版本或部署目標無法對回；
- `CONTINUITY_OPS_DEPLOYMENT_VERSION` 缺漏、無法對回核准 artifact，或平台 telemetry 顯示 `unversioned`；
- CI 、授權負例、主要流程、migration 或回歸未通過；
- 有未處理的嚴重授權、憑證、個人資料或租戶邊界問題；
- 備份／還原、rollback、監控、告警或值班責任未依本次風險完成；
- 外部使用發現重要可靠性問題，但尚未修正及重測；
- 發布範圍承諾由系統向外部狀態頁、Email 或訊息平台送達訊息，但沒有經驗證的整合、失敗處理與送達證據；
- 沒有具名的發布決定人與明確的 rollback owner。

## 9. 尚未完成且不得誤報的項目

目前已有 1265×513 與 360×844 應用程式視窗的內部本機瀏覽器核對，以及 Axe 選定規則掃描；本輪未重跑兩分頁輪詢，也沒有證據支持真實裝置、跨瀏覽器、真實螢幕閱讀器、遠端或正式獨立 QA 已完成。本機 590 次唯讀請求不能支持 production 容量、壓力極限、soak、寫入負載或 SLO。clean-room 的 97 個來源檔／18 個命令與 manifest 15/15 已通過，但仍不支持獨立 remote clone、CI、bit-for-bit 可重現或正式發布。仍沒有證據支持邊緣 rate limiting、服務生命週期歷程以外清單的 cursor pagination、真實服務健康遙測、外部狀態頁／Email／訊息平台整合、production private identity edge 負例、CSP nonce／hash 收斂、遠端備份還原與 rollback 演練、外部目標使用者驗證、資料匯出 API、正式 SAST／DAST／滲透測試、獨立安全查核或完整 WCAG 2.2 AA 查核已完成。

服務生命週期歷程已有簽章 keyset cursor；其他清單的固定查詢上限不是 cursor pagination。8 秒與 30 秒輪詢不是即時推播；系統內 published 不是外部送達；source 中的 CSP 與其他安全標頭不是遠端瀏覽器證據；冪等回執的 24 小時有界清理不是一般資料保存工作；內部 smoke、合成資料與自動測試也不能代替外部使用者或獨立查核。若候選版要進入 production，必須依風險完成相應控制與證據，或由具名決定人記錄不可接受而停止發布。
