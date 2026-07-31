# Continuity Ops 作業手冊

版本：`2.2.0`

狀態：`proposed / not exercised`

適用範圍：單一組織的 Cloudflare Worker 與 D1 部署

本手冊提供發布、中止、回復、備份還原、身分設定變更與營運事件處理步驟。目前沒有證據可以證明這些步驟已在遠端環境演練或已達成任何 RTO／RPO。

介面與互動的設計依據見 [產品設計基準](product-design.md)。該文件不表示功能已部署或通過驗證。

## 1. 角色與聯絡資料

正式發布前必須在受控的營運系統填寫：

| 責任 | 必填資料 |
|---|---|
| Release owner | 姓名、當次發布時間、go/no-go 權限 |
| Database owner | D1 備份、migration、還原與資料查核責任 |
| Security owner | 身分轉送、權限、憑證、資料暴露與資安事件決定 |
| Incident commander | 發布異常或營運事件的協調、狀態與結案責任 |
| Communications owner | 內部更新、利害關係人與需要時的對外說明 |
| Rollback operator | 具有回復 Worker 與處理 migration 的授權人員 |

聯絡資料不寫在公開 repository。應保存於組織核准的值班、服務目錄或秘密管理系統。

## 2. 發布輸入

下列資料不完整時停止發布：

- 不可變的 source commit；
- CI run ID 及全部必要關卡結果；
- 建置 artifact digest；
- 不可變且可對回 source commit 或 artifact 的 `CONTINUITY_OPS_DEPLOYMENT_VERSION`；
- 由平台 secret 管理、至少 32 字元且不與其他環境共用的 `CONTINUITY_OPS_CURSOR_HMAC_SECRET`；
- 目標環境、Worker 名稱、D1 資料庫名稱與 migration 版本；
- 本次變更範圍、可觀測指標、預期結果與回復觸發條件；
- D1 備份位置、digest、建立時間與存取限制；
- release owner、database owner 及 rollback operator。

## 3. 本機基準

```powershell
$OpsProjectPath = "C:\path\to\continuity-ops"
Set-Location -LiteralPath $OpsProjectPath
npm ci
Copy-Item -LiteralPath .dev.vars.example -Destination .dev.vars
npm run gate:ci
```

`.dev.vars` 只能用於 localhost。`CONTINUITY_OPS_ENVIRONMENT` 必須是 `development`，並明確設定本機操作者 ID、姓名、email 及角色。任何 staging／production 環境不得定義本機身分變數。

本機可將 `CONTINUITY_OPS_DEPLOYMENT_VERSION` 設為明確的開發標記。Staging／production 必須改為不可變且可追溯的 release 值；未設定時 API request telemetry 會記為 `unversioned`。

`CONTINUITY_OPS_CURSOR_HMAC_SECRET` 簽署並驗證服務生命週期分頁 cursor。不得將真實值寫入 repository、指令輸出、Log、遙測或 evidence artifact。輪替後，既有 cursor 會失效；重新載入第一頁即可取得新 cursor。

## 4. Staging 發布

1. 確認目標是 staging，並將資料庫、Worker、domain 與 production 分離。
2. 備份 staging D1，記錄輸出檔 digest。
3. 先在新建的空白 D1 執行全套 migration，再在 staging 執行增量 migration。
4. 查核 migration 狀態、table／index／constraint／trigger 及關鍵資料數量。
5. 部署 CI 產生的同一 artifact，不在部署機器重新建置。
6. 完成平台身分轉送設定，確認來自公開用戶端的同名 header 無法偽造信任。
7. 執行主要流程、授權負例、版本衝突、重複請求、稽核記錄與安全標頭檢查。
8. 從 JSON request telemetry 確認 route template、request ID、狀態、問題代碼、延遲、API／schema／deployment version 可被查詢；若 deployment version 為 `unversioned`，停止發布。
9. 確認錯誤、延遲、拒絕、資料庫異常與身分失敗可被監控及告警。
10. 執行受控回復及備份還原演練。
11. 記錄未通過項目；不得以緊急發布為由將失敗改記為通過。

## 5. Production 發布

Production 只能使用已在 staging 驗證的同一 artifact。

1. 宣告發布窗口，確認 release owner、database owner 與 rollback operator 在線。
2. 確認當前版本、目標版本、D1 migration 前版本與備份 digest。
3. 套用向前相容的 migration。架構刪除或收縮應使用 expand/contract 分階段處理。
4. 部署已驗證 artifact，記錄 deployment ID、時間、執行者與 digest。
5. 執行無破壞性 smoke：健康狀態、身分、讀取、新建受控事件、授權拒絕、稽核記錄與版本標識。查核 request telemetry 的 deployment version 與核准發布值相同且不是 `unversioned`。
6. 在發布觀察窗口查看使用者影響、錯誤率、拒絕類型、延遲、D1 錯誤與未處理例外。
7. 由 release owner 核准完成，或依觸發條件立即回復。

## 6. 中止與回復條件

下列情況不等待觀察窗口結束：

- 身分或授權無法 fail closed；
- 錯誤組織或錯誤使用者可讀寫受限資料；
- 憑證、可辨識資料或未受限的原文意外暴露；
- 稽核記錄缺失、無法歸責或可由一般使用者覆寫；
- 核心事件流程無法完成或發生不可接受的資料不一致；
- migration 造成資料遺失或舊版 application 無法安全讀取；
- 監控或告警本身失效，使發布風險無法判斷。
- `CONTINUITY_OPS_DEPLOYMENT_VERSION` 缺漏、無法對回核准 artifact，或 request telemetry 顯示 `unversioned`。

## 7. 應用程式回復

1. 由 incident commander 宣告回復，凍結其他非必要變更。
2. 保留現場證據：deployment ID、請求／trace ID、錯誤範圍、指標、Log 及使用者影響。
3. 將流量回復至上一個已驗證 artifact。不在回復時現場重新建置。
4. 執行健康、身分、授權、核心讀寫與稽核記錄 smoke。
5. 確認錯誤率、延遲與使用者影響回到核准範圍。
6. 記錄回復耗時、手動步驟、失敗項目與後續改善。

若 migration 不向後相容，不得單獨回復 application。轉由 database owner 依當次核准的資料回復方案處理。

目前資料契約版本為 `0004`。從早期 `0001` 升級時，database owner 必須在 staging 先查核 `0002` 產生的保守狀態調整；`0003` 會檢查所有啟用中事件指派是否符合組織角色相容矩陣。若存在不相容指派，migration 會以 `OPS_ASSIGNMENT_ROLE_INCOMPATIBLE` 停止，不會自動刪除、撤銷或改寫歷史。`0004` 新增服務生命週期變更原因、操作者、request ID、時間與 append-only 歷程；SQL migration 與 Drizzle 都以 service ID／organization ID 複合外鍵限制歷程歸屬。只有換行、歸位、tab、vertical tab、form feed 或 NBSP 的原因會被視為空白。既有已淘汰服務若沒有歷史理由，欄位維持空值；日後真實重新啟用時才建立第一筆歷程，不得補寫推測內容。database owner 必須先辨識 `0003` 停止項目的責任歸屬，透過既有交接或撤銷流程處理後，再從乾淨的 migration 狀態重試；不得刪除 guard 或直接重跑部分 SQL。

## 8. D1 備份與還原演練

備份範例：

```powershell
$OpsDatabaseName = "<REMOTE_D1_DATABASE_NAME>"
$OpsBackupPath = "<APPROVED_RESTRICTED_BACKUP_PATH>"
npx wrangler d1 export $OpsDatabaseName --remote --output $OpsBackupPath
Get-FileHash -LiteralPath $OpsBackupPath -Algorithm SHA256
```

執行前必須使用當前 Wrangler 官方說明確認參數，並將輸出存在組織核准的受限位置。

還原演練必須對新建的隔離資料庫進行，不得覆寫原 production D1：

1. 建立隔離的 restore-test D1。
2. 核對備份 digest 與存取權限。
3. 匯入備份，保留完整執行 Log。
4. 查核 migration 版本、關鍵 table 數量、外鍵／constraint、事件時間軸與稽核記錄關聯。
5. 在還原庫執行只讀查核與受控核心流程。
6. 記錄還原開始／完成時間、實際耗時、缺漏與人工步驟。
7. 依資料保存政策安全處理演練資料庫與備份。

RTO／RPO 只能根據已核准目標與實際演練結果報告；本手冊不預設數字。

## 9. 身分與 bootstrap 設定變更

- Production 來源只信任由平台已驗證並阻擋外部偽造的身分 header。
- `CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL` 只允許符合平台已驗證 email 的身分建立初始管理員。初始管理員成員資格建立並驗證後，應移除 bootstrap 設定。
- Ready 狀態下先查既有會員資格。既有角色（包含 `admin`）維持不變；既有 `suspended` 會員維持停用，不得因符合校內網域而重新啟用。
- 只有正規化後精確屬於 `@ntub.edu.tw`，而且尚無會員資格的已驗證帳號，才在首次登入建立啟用中會員，並隨機指派 `observer` 或 `auditor`。相似網域、子網域及其他網域的未受邀帳號均回傳 403。
- `observer` 與 `auditor` 只能讀取營運總覽、全部事件、服務、稽核及自己的存取政策。其所有 `POST`、`PUT`、`PATCH` 與 `DELETE` 必須由伺服器拒絕；存取政策不得包含成員目錄，稽核回應不得包含 actor email。`admin` 仍可查看 actor email。
- 變更 bootstrap email 前，由 security owner 與 release owner 雙人核對目標、變更單、環境與生效時間。
- 變更後以既有管理員、既有一般會員、`suspended` 會員、首次登入校內帳號及其他網域未受邀帳號執行受控登入；逐一查核可見資料、所有 HTTP method 負例、角色是否被保留、成員目錄與 actor email 是否被省略，並查核稽核記錄。
- 本機身分變數不得存在 staging 或 production。

## 10. 產品營運控制

### 10.1 服務生命週期

1. 新服務建立為 `active`；slug 建立後不可修改。
2. 變更名稱、owner、負責團隊、SLO、Runbook 連結或 tier 時，使用目前 version 並提供新的 Idempotency-Key。
3. 淘汰或重新啟用服務時，由具 `service:write` 權限的啟用中 admin／commander 使用目前 version 與新的 Idempotency-Key；在專用區塊確認影響，並填寫 8–1000 字的實際原因。API 要求 `lifecycleConfirmed: true`；只有空白控制字元或 NBSP 的內容不算理由。
4. 淘汰前查核沒有狀態非 `closed`／`cancelled` 的事件。若仍有未結案事件，API 與資料庫會拒絕改為 `deprecated`。
5. 成功變更後，查核服務目前狀態、原因、操作者、時間及 request ID，並在生命週期歷程確認新增一筆由原狀態到新狀態的紀錄。歷程不可更新或刪除；若是 0004 前已淘汰的舊資料，缺少舊理由是已知事實，不得補造，真實重新啟用才建立新紀錄。
6. `deprecated` 服務保留歷史資料且不接受新事件；重新使用前必須確認責任歸屬與事件應變準備，再依前述程序改回 `active`。
7. 服務健康遙測尚未接入時，畫面與 API 應維持 unknown／unavailable／null，不得把沒有事件解讀為正常或達成 SLO。

### 10.2 事件角色撤銷與交接

1. 撤銷採軟撤銷，保留指派、結束時間及執行者；不得直接刪除歷史指派。
2. 撤銷非最後一位事件指揮官時，可直接撤銷；撤銷最後一位時必須選擇啟用中且組織角色為 `admin` 或 `commander` 的不同成員。
3. 接任指派、原指派撤銷、時間軸、稽核與冪等回執由伺服器在同一 D1 batch 完成。任何 guard 失敗都不得留下只完成一半的交接。
4. 若成員仍是任何未結案事件唯一的合格事件指揮官，先停用或降級其組織角色會被拒絕；先完成事件交接。

### 10.3 驗證證據與復原

驗證時間軸不是原始 Log 儲存區。建立 `verification` 紀錄時，可填寫 HTTPS 參考連結、來源標籤、觀測起訖時間及選填 SHA-256 digest；digest 是外部資料的完整性線索，不證明內容正確。

工作建立及未完成狀態可不填證據；狀態改為 `completed` 前，必須提供具有主機名稱的 HTTPS 證據網址。`critical` 工作取消時必須提供 8–1000 字理由；不得在同一次更新先降級再略過理由，已保存的取消理由也不得移除或改寫。API 與 D1 都會拒絕不符合條件的更新。Continuity Ops 只保存網址與理由，不擷取或驗證外部內容。操作者仍須確認證據屬於正確事件、版本、時間範圍與工作結果；只把工作標記為完成或取消，不足以證明成果正確。

事件從 `monitoring` 進入 `resolved` 前，三項條件必須同時成立：

1. 事件已定義非空白的復原判定條件。
2. 至少一筆 `verification` 紀錄建立於進入本次 `monitoring` 之後。重新進入 `investigating` 會重設監控週期；舊週期證據不得沿用。
3. 所有 `critical` 工作已為 `completed` 或 `cancelled`。

前端只做預先提示，API 權限、狀態機及 D1 trigger 才是最終判定。解決後若指標惡化，事件指揮官應將事件重新開啟為 `investigating`，重新進行處置、監控與驗證。

### 10.4 結構化事件通訊

1. 溝通負責人先選擇內部、利害關係人或公開受眾，再以已確認的事實建立 `draft`。草稿可修改；不要在未確認前把假說寫成事實。
2. `admin`，或具本事件 `incident_commander`／`communications_lead` 指派的 `commander`，可將草稿改為 `reviewed`；`responder` 必須具 `communications_lead` 指派。`observer` 與 `auditor` 不得核准。操作者必須先確認內容、受眾、受影響元件與下一次更新安排；已核准內容若需改變，應建立新的草稿。
3. 只有 `reviewed` 可標記為 `published`。`published` 紀錄不可更新或刪除，且事件進入 `resolved`、`closed` 或 `cancelled` 後不得再標記發布。
4. 利害關係人與公開通訊必須在草稿核准前安排晚於核准時間的下一次更新。最終公告可免填，但訊息必須從第一個字元使用大小寫不拘的獨立 `[FINAL]` 標記；標記後必須是空白或訊息結束。發布時會再次確認排程仍在未來；若已過期，建立並重新核准新的草稿。
5. 系統會為建立、更新、核准及標記發布保存版本、時間軸、稽核與冪等回執。版本衝突時先重新讀取，不得用覆寫方式跳過他人變更。
6. `published` 只表示 Continuity Ops 內的版本已核准並鎖定。本版不會更新外部狀態頁、寄送 Email 或傳送至訊息平台，也沒有外部送達回執。若事件需要實際通知，溝通負責人須依組織核准的其他管道另行執行及查核。
7. 事件狀態變更、角色撤銷與交接、工作完成或取消、成員降權或停用、服務淘汰／重新啟用，以及通訊核准與標記發布已有確認、風險提示或理由欄位。服務生命週期變更使用專用確認區塊並保存逐次歷程。2.2.0 已完成 1265×513 桌面與 360×844 手機應用程式視窗、深層連結、事件分頁 End／Home／方向鍵、瀏覽器前進後退、dialog／drawer 焦點，以及 axe 選定規則的本機核對。本輪未重跑兩分頁輪詢。其他高風險介面、真實行動裝置、輔助技術、遠端與獨立 QA 仍須驗證。無論畫面是否要求再次確認，API 權限、狀態、版本與資料庫限制都是最終判定。

### 10.5 事後檢討

1. 只有 `resolved` 或 `closed` 事件可建立或更新事後檢討。
2. `draft` 可逐步補寫；`completed` 必須填妥摘要、使用者影響、根本原因、偵測缺口、經驗與後續行動六個段落。
3. 新檢討使用 expected version `0`，後續更新使用目前 version；版本衝突時重新讀取後再決定如何合併。
4. 已完成檢討所屬事件重新開啟時，系統會將檢討改回 `draft`、增加 version，並新增時間軸與稽核紀錄。

### 10.6 冪等回執與平台遙測

- 每次寫入使用新的 Idempotency-Key。網路逾時後重送相同 key 與完全相同 payload；不要重用 key 提交不同內容。
- 成員資料更新必須使用最新 `expectedVersion`。收到版本衝突時重新讀取成員資料、核對另一位管理者的變更，再決定是否提出新的更新；不得直接增加版本值重送以覆蓋他人決定。
- 回執有效 24 小時。同組織建立新回執時會有界清除最多 100 筆過期回執，也會清除與本次 key 相符的過期回執。這不是一般事件或稽核資料的保存排程。
- 平台 request telemetry 為單行 JSON，不含 request body 或原始 URL 資源 ID。應以 request ID 關聯 API 問題回應、平台 Log 與 D1 稽核；不得將 telemetry 當成原始事件證據。
- 已驗證且尚無會員資格的身分，只有精確 `@ntub.edu.tw` 網域會建立唯讀會員；其他網域未受邀者回傳 403。既有 `suspended` 會員不走自動建立流程。認證失敗不建立不可信 actor 稽核，但 request telemetry 仍應記錄有界 route 與結果。

### 10.7 畫面更新與深層連結

- 畫面可見且沒有寫入進行時，選取事件的明細、時間軸與通訊每 8 秒重新讀取；總覽每 30 秒重新讀取。頁面重新可見時會立即更新事件明細。
- `CONTINUITY_OPS_ORGANIZATION_TIMEZONE` 必須是有效 IANA 時區。D1 保存正規化後的值，時間顯示與地方時間輸入皆依此轉換；缺漏或無效時採 UTC。日光節約時間中不存在或有兩種可能的地方時間不得提交。
- 輪詢不是即時推播。執行狀態轉換、交接、通訊核准或其他高風險決定前，先確認畫面的最後更新時間；資料狀態不明時重新整理並以 API 回應為準。
- `view`、`incident` 與 `tab` 查詢參數可建立特定畫面的連結並支援瀏覽器前進、後退。URL 不授予權限，伺服器仍會驗證身分與資源存取。
- 不得把秘密、憑證、個人資料或事件原文放入查詢參數。分享深層連結前，仍須確認收件人具有適當的組織成員資格與事件讀取權限。

## 11. Continuity Ops 本身發生事件

參考 [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final) 與 [Google SRE Incident Management Guide](https://sre.google/resources/practices-and-processes/incident-management-guide/)，但本手冊不代表已滿足全部建議。

1. 宣告事件、設定影響與嚴重度，指派 incident commander。
2. 保全證據；避免在尚未了解影響時清除 Log 或資料。
3. 優先限制使用者影響與擴大範圍，必要時關閉高風險寫入或回復已驗證版本。
4. 建立固定更新節奏，分開已知事實、尚待查證假說、已執行處置與下一步。
5. 驗證服務恢復與資料一致後才解決；必要時重新開啟。
6. 保留不責怪個人的事後檢討，建立可驗收的改善項目、負責人與期限。

## 12. 尚未完成的 production 前置工作

服務生命週期歷程已有本機簽章 keyset cursor、API 測試及內部瀏覽器證據。受控本機檢查也已涵蓋 1265×513 桌面與 360×844 手機應用程式視窗、鍵盤與焦點操作、故障後重新套用 migration，以及隔離 D1 邏輯備份與還原；本輪未重跑兩分頁輪詢。這些結果不是遠端或獨立 QA 證據。目前尚無遠端證據支持邊緣 rate limiting、production identity edge 對偽造 header 的阻擋、校內帳號首次登入建立、既有會員優先、唯讀 method 限制與欄位最小化政策、真實服務健康遙測、外部狀態頁／Email／訊息平台整合、CSP nonce／hash 收斂、遠端備份還原與 rollback 演練、外部目標使用者驗證、獨立安全查核及完整 WCAG 2.2 AA 查核。本機結果不得替代這些證據。

沒有相應控制、核准的殘餘風險及具名 go/no-go 決定時，不得把本手冊狀態從 `proposed / not exercised` 改為已驗證。

## 13. 作業紀錄範本

| 欄位 | 內容 |
|---|---|
| Change/incident ID | 組織的變更或事件編號 |
| Source | commit、artifact digest、migration 版本 |
| Environment | staging／production、Worker、D1、domain |
| People | release owner、database owner、security owner、rollback operator |
| Timeline | 核准、備份、migration、部署、smoke、回復／完成時間 |
| Evidence | CI run、deployment ID、Log／trace 查詢、備份 digest、測試結果 |
| Decision | go、no-go、rollback、理由與未解決限制 |
| Follow-up | 改善項目、負責人、期限與驗收方式 |
