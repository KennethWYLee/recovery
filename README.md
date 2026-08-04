# Continuity Ops

Continuity Ops 是單一組織部署的服務事件指揮與復原工作區。它讓 IT 維運、SRE、資安應變與服務負責人在同一件共享事件中協作，保留調查、處置、驗證、決策與事後改善的可追溯記錄。

目前版本為 `2.2.0`。這個 repository 是可部署的發布來源；repository 內容本身不證明任何特定遠端版本仍在線。正式狀態必須另以 source commit、deployment ID、正式網址與遠端查核結果確認。本版不主張公開部署、外部使用結果、獨立資安查核或 WCAG 符合性。

## 產品邊界

- 一次部署服務一個組織；本版不主張已完成多租戶隔離。
- 系統用於紀錄與協調，不直接執行生產環境指令，也不保存生產應用憑證。
- 正式環境必須使用平台已驗證的使用者身分；本機操作者身分只允許在 localhost 並明確設定環境變數時使用。
- Cloudflare D1 保存結構化營運資料。附件、SIEM、外部狀態頁、Email 與訊息平台整合尚未實作，不得宣稱已連線或已送達。
- 通訊的 `published` 只表示具權限的操作者已在 Continuity Ops 內完成核准與標記，不表示訊息已傳送給外部受眾。

完整產品契約見 [PROJECT.md](PROJECT.md)。

## 技術架構

- React、Next-compatible App Router 與 vinext
- Cloudflare Worker 執行環境
- Cloudflare D1 結構化資料庫
- Drizzle schema 與納入版本控制的 migration
- 伺服器端身分、權限、狀態轉換、版本與資源關係驗證
- 事件時間軸、追加式稽核記錄與平台遙測的分離設計

產品互動、架構、威脅邊界與維運步驟分別見 [產品設計基準](docs/product-design.md)、[安全模型](docs/security-model.md) 及 [作業手冊](docs/operations-runbook.md)。

## 目前已實作的營運控制

- 服務目錄支援建立、版本化更新、`active`／`deprecated` 生命週期、不可變 slug、SLO 目標、啟用中成員 owner、負責團隊及 HTTPS Runbook 連結。每次生命週期變更必須留下 8–1000 字原因、合格操作者與時間；仍有未結案事件時，資料庫會拒絕淘汰服務。生命週期歷程使用 HMAC-SHA256 簽章、綁定服務與組織的 opaque keyset cursor；缺少至少 32 字元的簽章 secret 時拒絕提供歷程頁面。升級前已淘汰的舊資料保留「未記錄原因」狀態，系統不補寫不存在的歷史理由。
- 組織角色與事件指派分開判定，並使用 API 與 D1 共用語意的相容矩陣。`admin` 是唯一不需要事件指派的全域寫入例外；`observer` 與 `auditor` 可唯讀查看營運總覽、全部事件、服務、稽核及自己的存取政策，不會因事件指派取得寫入權限。`service_owner` 是事件內的應變角色，不會授予服務目錄寫入權限；目前只有 `admin` 與 `commander` 具有 `service:write`。
- 事件指派以 `active`／`revoked` 保存，不實體刪除。撤銷最後一位事件指揮官時必須指定具資格的接任者，交接與撤銷在同一資料庫批次完成。
- 事件通訊以 `draft`、`reviewed`、`published` 保存。只有草稿可以編輯，已核准內容不得改寫，已發布紀錄不可更新或刪除。利害關係人與公開通訊在核准前，必須安排晚於核准時間的下一次更新，或從第一個字元使用大小寫不拘的獨立 `[FINAL]` 標記；標記後必須是空白或訊息結束。發布時會再次確認排程仍在未來，過期時必須建立並重新核准新草稿。
- 介面已對事件狀態變更、服務淘汰或重新啟用、角色撤銷與交接、工作完成或取消、成員降權或停用，以及通訊核准與標記發布提供相稱的確認、風險提示或理由欄位。介面確認不能取代 API 權限、狀態、版本與資料庫限制。
- 事件只能從 `monitoring` 進入 `resolved`。提交前必須已定義復原判定條件、留有進入本次監控週期後的 `verification` 紀錄，且所有 `critical` 工作均已完成或取消。
- 驗證紀錄可保存 HTTPS 參考連結、來源標籤、觀測起訖時間與選填 SHA-256 digest。系統不保存原始 Log 或附件；這些欄位是證據索引，不代表外部資料已由系統驗證內容真偽。
- 工作建立及未完成狀態可不填證據；狀態改為 `completed` 前，必須提供具有主機名稱的 HTTPS 證據網址。API 與 D1 都會拒絕缺漏或不合法的網址。`critical` 工作取消時必須留下 8–1000 字的理由；同一請求內先降級再取消仍受限制，已記錄的理由不得移除或改寫。系統只保存網址，不擷取或驗證外部內容，且完成或取消狀態本身不能證明成果正確。
- 事後檢討支援 `draft` 與 `completed`，且只能在事件已解決或結案後儲存。事件重新開啟時，已完成的檢討會回到草稿並增加版本，同時留下時間軸與稽核紀錄。
- 所有目前的寫入端點要求 Idempotency-Key；相同 payload 可取得已保存回應，相同 key 搭配不同 payload 會被拒絕。回執保存 24 小時，建立新回執時執行有界的過期清理。
- 未接入服務遙測時，服務狀態明確呈現為未知，SLO attainment 為無資料；系統不以零事件推論服務正常。
- 正式環境先採用既有會員資格；既有使用者或會員若為 `suspended`，不會因再次登入而恢復。正規化後 Email 網域精確為 `ntub.edu.tw` 的已驗證帳號，首次登入先建立安全的唯讀會員；每次從登入入口進入時，可選擇 `commander`、`responder`、`observer` 或 `auditor`。`admin` 不列入角色選項，只能由既有授權或部署設定指派。角色選擇會更新伺服器端會員權限；若仍有進行中的事件責任，系統會拒絕不相容的切換。`observer` 與 `auditor` 維持唯讀且看不到成員目錄或稽核 actor email。其他網域未受邀帳號仍回傳 403。最後一位啟用中的管理員不能被停用或降級；所有角色更新都使用版本條件，避免並行操作靜默覆寫。
- API request telemetry 使用不含 request body、身分資料與原始資源 ID 的固定欄位，包含 request ID、route template、狀態、問題代碼、延遲、API／schema／部署版號。schema `0005` 將紀錄保存至 D1；「系統觀測」依 24 小時、7 天或 30 天呈現流量、4xx／5xx、延遲、主要路徑與最近錯誤。資料匯出 API 尚未實作。
- JSON request body 以串流累計實際 bytes，不能只依賴可能缺漏或不正確的 `Content-Length`。超過 32 KiB 時會取消讀取並回傳 413；無效 UTF-8、JSON 或非 object 根節點會被明確拒絕。這是應用程式層限制，不代表已驗證託管平台的 edge 限制。
- 畫面可見且沒有寫入進行時，選取事件的明細、時間軸與通訊每 8 秒重新讀取；總覽每 30 秒重新讀取，頁面重新可見時會立即更新事件明細。這是輪詢，不是即時推播，也不能證明外部通訊已送達。
- 組織時區保存於 D1，並可用 `CONTINUITY_OPS_ORGANIZATION_TIMEZONE` 設為有效的 IANA 時區。畫面、到期時間、通訊排程與證據觀測時間使用同一組織時區；缺值或無效值以 UTC 顯示，日光節約時間中不存在或有兩種可能的地方時間會被拒絕。
- `view`、`incident` 與 `tab` 查詢參數可建立畫面深層連結並支援瀏覽器前進、後退。URL 不授予權限，伺服器仍會對每次請求重新驗證身分與資源存取。

## 本機開發

需要 Node.js `>=22.13.0`。

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
# 確認 .dev.vars 的本機操作者身分與角色。
npm run db:migrate:local
npm run dev
```

`.dev.vars` 已排除於版本控制。不得將真實憑證、生產資料或可辨識使用者資料寫入範例檔、終端輸出、測試證據或 repository。

Open Graph、Twitter 與 canonical metadata 會依目前請求的 HTTPS host 產生；部署後應從正式網址核對轉送 host 與 protocol 是否正確。

`CONTINUITY_OPS_PUBLIC_ORIGIN` 是登入頁手機 QR Code 的正式 HTTPS origin，不含 path、query 或 fragment。QR 只連到同站的 `/role-selection`，不包含帳號、密碼、session 或權杖；未設定時才使用受託管平台轉送的 HTTPS host。正式部署應明確設定並掃碼核對目的網址。

`CONTINUITY_OPS_DEPLOYMENT_VERSION` 是寫入平台結構化遙測的不可變發布識別，應設為可對回 source commit 或 artifact 的值。未設定時系統會記錄 `unversioned`；本機可用明確的開發標記，但 staging 與 production 發現 `unversioned` 必須停止發布。

`CONTINUITY_OPS_CURSOR_HMAC_SECRET` 用於簽署生命週期分頁 cursor，至少 32 字元。正式環境應以平台 secret 管理，不得寫入 repository、Log、遙測或證據檔；各環境使用不同值。輪替後，輪替前取得的 cursor 會失效，使用者必須重新載入第一頁。

`db:migrate:local` 使用 Wrangler 的 migration 紀錄，只套用尚未套用的 [`db/migrations`](db/migrations) 檔案。它不會對已完成的資料庫盲目重跑 SQL；如果 migration 失敗，開發伺服器不會啟動。可以使用 `npm run db:migrations:list:local` 查看本機狀態。

資料契約版本目前為 `0005`。`0002_continuity_ops_contract_upgrade.sql` 補齊時區、成員版本、指派歷程、證據欄位、通訊與約束；`0003_assignment_role_integrity.sql` 加入組織角色與事件角色的相容性限制；`0004_service_lifecycle_accountability.sql` 保存並限制未來服務生命週期變更的原因、操作者與時間；`0005_request_observability.sql` 保存不含內容與身分資料的結構化請求紀錄。`0003` 發現既有不相容指派時會停止；`0004` 不會替既有淘汰狀態捏造歷史理由。

### 全新託管 D1 初始化

本機開發、既有資料庫升級、還原演練與回歸測試使用 0001–0005 migration。全新空白的 Sites D1 則由 Worker 內的受控 runtime bootstrap 建立最終 `0005` 結構；兩條路徑有不同用途，runtime bootstrap 不可用來升級已有正式資料的資料庫。

Runtime bootstrap 固定分成三個可重試階段。三階段分別建立 29、33、23 個 schema statements；含狀態查核、guard 與最終 fingerprint 驗證後，本機實測各請求使用 39、39、33 個 D1 queries，均低於 50。只有平台已驗證，且正規化 Email 與 `CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL` 完全相同的身分可以推進；一般請求在完成前收到 503，讀取介面只對明確的初始化狀態做有限次重試。每階段以 D1 batch 交易執行，失敗不保留該階段的部分結果。

系統只在 15 個產品資料表、22 個 index、46 個 trigger 與 canonical fingerprint 全部相符後標記 ready。若資料庫已有部分或不相符的 `ops_` 結構，初始化會停止，不會自動刪表或補寫。由 Wrangler 完整套用的既有資料庫，必須同時具有完全相符的最終結構與 0001–0005 migration 紀錄才可採用。完成第一位管理員建置後，可移除 bootstrap Email 設定；既有啟用會員仍可登入。

若要在本機檢查圖表與錯誤情境，先完成 migration，再執行 `npm run seed:demo:observability`。此命令只會取代本機資料庫中 `source = 'simulated'` 的請求紀錄，不會刪除正式執行紀錄，也不會連線到遠端 D1。畫面會持續標示模擬資料的筆數與用途。

兩次先前的 Sites 發布嘗試都在平台處理含 trigger 的完整 SQL migration 集合時失敗，錯誤為 `incomplete input`。本機整檔、逐 statement 與 Wrangler 驗證均通過；因此部署端 SQL 切割相容性是目前最符合證據的原因推論，但沒有平台 trace 可把它寫成已確認的 Sites 缺陷。目前部署包只交付不含 trigger、且與 `db/migrations/0005_request_observability.sql` 逐字相同的 `0005` 向前升級；既有 `0001`–`0004` 仍由已驗證的遠端資料庫狀態或 fresh-D1 runtime bootstrap 負責。

Vite 開發伺服器、migration 指令與建置後 Worker preview 均明確使用 `.wrangler/state` 作為本機持久化路徑，並共用 `continuity-ops-local-d1` binding。不要混用 Wrangler 的其他預設狀態目錄。

建置後的本機 Worker preview：

```powershell
npm run build
npm run db:migrate:local
npm run start -- --port 3001
```

## 品質關卡

```powershell
npm run gate:static
npm run gate:test
npm run gate:build
npm run audit:production
```

`npm test` 會執行 `gate:ci`。API、黑箱及有界的本機負載檢查需要另行啟動建置後的 Worker preview，再執行：

```powershell
npm run test:smoke
npm run test:blackbox:local
npm run test:load:local
```

`gate:test` 包含可執行 Gherkin 驗收與六項風險導向的 Gherkin 故障注入。後者只確認對應情境能抓到六個指定規則被改壞，不是完整 mutation score。

下列指令會自行建立隔離的本機資料庫或工作目錄，用於檢查故障後復原與從鎖定依賴重新建置：

```powershell
npm run test:failure-recovery:local
npm run test:runtime-bootstrap:local
npm run test:clean-room
node scripts/run-local-d1-restore-drill.mjs
```

每項證據的分母、成品雜湊、限制與未執行項目見 [`docs/assurance`](docs/assurance/README.md)。

檢查通過只表示指定關卡成功，不等於已部署、已通過獨立資安查核或已取得外部使用證據。CI 步驟定義在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)；正式發布紀錄應保存可核對的 GitHub Actions run ID、source commit 與 artifact digest。

## 部署與發布

正式發布前至少需要：

1. 以不可變的 source commit 執行 CI。
2. 從正式網址查核 canonical 與社群預覽 metadata 使用正確的 HTTPS host。
3. 對全新託管 D1 核對 ready 前 503、三個 bootstrap 階段、每次少於 40 queries、最終 inventory／fingerprint，以及不相符身分不能初始化；既有資料庫則走 0001–0005 migration 與還原程序。
4. 完成平台已驗證身分轉送的信任設定，將 bootstrap administrator email 視為受控部署設定，並在第一位管理員建立後移除。從正式邊界核對 `suspended` 不復原、精確 `@ntub.edu.tw` 帳號取得四種非管理員選項、`admin` 無法自選、角色切換後伺服器權限正確、其他網域未受邀者回傳 403，以及唯讀角色不能取得成員目錄或 actor email。
5. 在 ready 後執行 health、API、授權負例與主要流程測試。
6. 設定不可變的 `CONTINUITY_OPS_DEPLOYMENT_VERSION`，並從結構化 request telemetry 確認不再出現 `unversioned`。
7. 以平台 secret 設定至少 32 字元的 `CONTINUITY_OPS_CURSOR_HMAC_SECRET`，並確認未出現在 Log、遙測或 evidence artifact。
8. 記錄 artifact digest、deployment ID、schema 版本與具名的 go/no-go 決定。
9. 執行並記錄 rollback 及 D1 備份還原演練。

本機證據不能代替上述遠端查核。詳細步驟與停止條件見 [作業手冊](docs/operations-runbook.md)。

尚未完成的 production 能力包括邊緣 rate limiting、生命週期歷程以外清單的 cursor pagination、附件與匯出、真實服務健康遙測、外部狀態頁／Email／訊息平台整合、高風險確認流程的遠端瀏覽器驗證、遠端身分邊緣負例、校內帳號自動建立與唯讀資料最小化政策的遠端驗證、CSP nonce／hash 收斂、production 備份還原演練、外部目標使用者驗證及獨立安全與可及性查核。固定筆數上限與目前的 CSP `unsafe-inline` 相容設定不能替代這些工作。

## 設計參考與證據狀態

本專案參考下列官方文件，但「參考」不代表已完成全部控制、已通過驗證或取得符合性認定：

- [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final)
- [Google SRE Incident Management Guide](https://sre.google/resources/practices-and-processes/incident-management-guide/)
- [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release)
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)

品質證據的狀態、限制與內部對照放在 [`docs/assurance`](docs/assurance/README.md)。不得將本機、合成或尚待執行的結果寫成正式環境已驗證事實。
