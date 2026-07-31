# Continuity Ops 需求、程式與驗證追溯矩陣

基準：驗收契約 `1.0.0`、產品 `2.2.0`、schema `0004`  
狀態說明：表中「測試」表示測試位置或既有證據，不保證每次修改後仍有效；執行狀態以 [證據狀態登錄](evidence-status-register.md) 為準。

## 1. 驗收契約追溯

| 契約 | 介面或 API | 主要程式責任 | 資料表或資料庫保護 | 測試與證據 | 目前判斷 |
|---|---|---|---|---|---|
| AC-001 | `/api/v1/access` | `authenticatedContext`、`resolveExternalOperationsIdentity`、`loadOrProvisionOperationsActor` | `ops_users`、`ops_memberships`、`ops_organizations` | `operations-authorization.test.ts`；CO-VRF-API-001／QA-BLACKBOX-001 | 本機授權與 caller-supplied 身分 header 不能取代設定中本機 actor 的黑箱案例已驗證；完整 production 身分邊界未驗證。 |
| AC-002 | 所有受保護 API、存取管理與事件指派畫面 | `requirePermission`、`organizationRoleCanHoldIncidentRole`、`canTransitionIncident`、`assertResponder`、`assertCommander`、通訊編輯／核准檢查 | 會員、事件指派、`ops_assignment_role_compatibility_insert_guard`、`ops_membership_assignment_compatibility_update_guard` 及最後管理員／指揮官 triggers | 授權／領域／migration；CO-VRF-GHERKIN-001／FAULT-001／API-001／SEC-001 | 本機 29/29 單元、migration、選定 Gherkin、18/18 故障注入與指定 Worker API 負例已驗證；正式身分邊界未驗證。 |
| AC-003 | `GET/POST /api/v1/services`、`GET/PATCH /api/v1/services/:serviceId`、`GET /api/v1/services/:serviceId/lifecycle-events?cursor=` | `services` handler、slug／URL／SLO、`statusChangeReason`、`lifecycleConfirmed`、request ID 與 HMAC-SHA256 簽章、綁定組織／服務的 keyset cursor | `ops_services`、`ops_service_lifecycle_events`；唯一 slug、version、open-incident、狀態證據、actor、metadata／history immutable guards、穩定 `(changed_at, id)` 排序 | 2.2.0 migration、`service-lifecycle-cursor.test.ts`；CO-VRF-API-001／SEC-001／BROWSER-001 | 本機 migration、簽章 cursor 單元案例、指定 Worker API 正反例與多頁歷程，以及同一 digest 的內部桌面分頁與確認介面已驗證；遠端、行動裝置與獨立 QA 未驗證。 |
| AC-004 | `GET/POST /api/v1/incidents` | `createIncident`、`listIncidents` | `ops_incidents`、`ops_incident_timeline`、`ops_audit_events`、冪等回執 | CO-VRF-GHERKIN-001／API-001 | 選定 Gherkin 與指定本機 Worker API 已驗證；正式環境未驗證。 |
| AC-005 | `/api/v1/incidents/:incidentId/assignments` | `incidentAssignments`、`requireActiveMember` | `ops_incident_assignments`；membership、commander role、revoke 與 immutable triggers | 2.2.0 授權／migration；CO-VRF-API-001／SEC-001 | 本機單元、migration 與指定 Worker API 已驗證。 |
| AC-006 | `POST /api/v1/incidents/:incidentId/transitions` | `transitionIncident`、`canTransitionIncident`、`incidentTimestampUpdates` | incident version／transition／actor／timeline triggers | domain、migration；CO-VRF-GHERKIN-001／FAULT-001／API-001／SEC-001 | 本機單元、migration、選定 Gherkin、指定 Worker API 與 18/18 風險導向故障注入已驗證；不是完整 mutation testing。 |
| AC-007 | `/api/v1/incidents/:incidentId/timeline` | `incidentTimeline`、HTTPS／觀測窗／digest 驗證 | `ops_incident_timeline`；唯一 request event、append-only triggers | migration evidence round-trip；CO-VRF-API-001／SEC-001 | 欄位與保存已驗證；外部內容未驗證。 |
| AC-008 | `/api/v1/incidents/:incidentId/tasks` | `incidentTasks`、`taskStatusHasRequiredEvidence`、`isDurableHttpsUrl` | `ops_incident_tasks`；完成證據與 critical 取消理由 checks／triggers | domain、migration；CO-VRF-GHERKIN-001／API-001／SEC-001 | 本機領域、migration、選定 Gherkin 與 API 已驗證。 |
| AC-009 | `/api/v1/incidents/:incidentId/communications` | `incidentCommunications`、通訊角色與 `[FINAL]` 判定 | `ops_incident_communications`；狀態、版本、內容不變、排程、終止事件 triggers | migration communications；CO-VRF-GHERKIN-001／API-001／SEC-001 | 內部狀態與選定 `[FINAL]` 情境已驗證；外部送達未實作。 |
| AC-010 | `POST .../transitions`，目標 `resolved` | `transitionIncident` | `ops_incident_resolution_readiness_guard`，查驗 `ops_incident_timeline` 與 `ops_incident_tasks` | migration resolution；CO-VRF-API-001／SEC-001 | 本機兩個 monitoring 週期已驗證。 |
| AC-011 | `GET/PUT /api/v1/incidents/:incidentId/review`；事件重新開啟 | `incidentReview`、`assertCompletedReview`、重新開啟處理 | `ops_post_incident_reviews`；完成內容、事件狀態、version triggers | migration review；CO-VRF-API-001／SEC-001 | 本機已驗證。 |
| AC-012 | 所有 mutation 的 `Idempotency-Key` | `idempotencyKey`、`executeIdempotentBatch`、`readIdempotentReplay` | `ops_idempotency_receipts` 唯一索引及 24 小時到期資料 | migration stateful retry；CO-VRF-API-001／SEC-001 | 本機 stateful retry 與兩個同時相同請求只建立一筆並重播同一回應已驗證；正式重試與清理監控未驗證。 |
| AC-013 | PATCH／PUT／狀態轉換 | `requiredInteger(expectedVersion)`、各 handler 的先讀回執與批次寫入 | 各 version trigger、`ops_write_guards` | migration version cases；CO-VRF-API-001／SEC-001 | 列出的資源與兩個同版本並行更新的一勝一衝突已在本機驗證；遠端競爭與中途故障未驗證。 |
| AC-014 | `/api/v1/audit`、所有 API 回應 | `auditInsert`、`rejectedMutationAudit`、`emitOperationsRequestTelemetry`、RFC 7807 problem response | `ops_audit_events` append-only；時間軸 append-only | bounded-route 單元案例；CO-VRF-API-001／SEC-001／TELEMETRY-001／BROWSER-001 | 指定本機 API 與受控 Log 已驗證；879/879 有效，其中 51 筆為預期 4xx、5xx 為 0，API／schema／deployment version 均一致。正式管線未驗證。 |
| AC-015 | UI 日期輸入、組織時區 | `resolveOrganizationTimeZone`、`parseZonedDateTimeInput`、`toZonedDateTimeInput` | `ops_organizations.timezone` | 2.2.0 `operations-time.test.ts`；[本機驗證紀錄](local-verification-record-20260731.md) | 時區與 DST 單元案例已驗證；瀏覽器及 API round-trip 未驗證。 |
| AC-016 | `GET /api/v1/health`、錯誤畫面 | `health`、route error normalization、UI request error handling | D1 health query | CO-VRF-API-001／FAILURE-RECOVERY-001 | 指定本機 artifact 的正常 health，以及未套 migration 時 503、套用 0001–0004 後恢復 3 個核心讀取已驗證；網路中斷、遠端 D1、rollback 與正式環境未驗證。 |
| AC-017 | `/operations?view=&incident=&tab=` | `OperationsApp.tsx` 的網址狀態、輪詢、dialog focus；`globals.css` 響應式規則 | 不適用；資料授權仍由 API 執行 | `rendered-html.test.mjs`；CO-VRF-BROWSER-001 | 1280×720 與 320×568 已核對鍵盤 tabs、modal 焦點、手機 drawer、前進後退與兩分頁輪詢；Axe 選定規則為 0 violation、0 incomplete。完整 WCAG、真實螢幕閱讀器、跨瀏覽器、真實裝置、正式獨立 QA 與遠端證據不足。 |
| AC-018 | 建置及交付流程 | `package.json` scripts、CI workflow、vinext／Worker 設定、manifest、telemetry analyzer 與 restore drill | migration 集合 | CO-VRF-CLEAN-ROOM-001／MANIFEST-001／D1-RESTORE-001 | clean-room 的 93 個來源快照檔、17 個命令與 71/71 API 已在本機隔離環境通過；最終 Worker SHA-256 已固定，本機建置、3/3 整合及 0001→0004 還原也已驗證，manifest 已盤點 14/14 份預期證據。來源仍是未提交工作目錄的複本，也沒有 clean Git checkout、CI run、artifact rollback 或正式部署證據。 |
| AC-019 | `GET /api/v1/overview`、服務目錄 | `overview` 的 `unknown`／`unavailable` 回應 | 事件與服務資料只用來呈現影響，不捏造遙測 | CO-VRF-API-001 | 指定 2.2.0 本機 Worker API 已驗證；真實服務遙測未接入。 |
| AC-020 | 外部專業使用者驗證 | [外部專業使用者驗證程序](external-professional-validation-protocol.md) | 測試結果不得直接寫入正式營運資料；依核准環境保存去識別紀錄 | 尚無結果 | `planned_template`。 |

`CO-VRF-GHERKIN-FAULT-001` 以 6/6 個手工設計故障核對 AC-002、AC-004、AC-006、AC-008 與 AC-009 的選定情境判別力，0 survived。它只涵蓋目前 8 個情境中的六項風險，不是完整 mutation campaign、所有需求的證明或獨立人類 QA。

## 2. Migration 追溯

| Migration | 目的 | 重要資料規則 | 查核方式 | 證據狀態 |
|---|---|---|---|---|
| `0001_continuity_ops_v2.sql` | 建立主要組織、使用者、服務、事件、事件協作、稽核、冪等及寫入保護資料結構。 | 外鍵、唯一索引、狀態 check、版本 check、事件轉換、解決條件、append-only。 | 空白資料庫安裝、schema 查詢、正反例 SQL。 | 測試來源存在；當次完整 Log 未納入本套文件。 |
| `0002_continuity_ops_contract_upgrade.sql` | 將早期 0001 結構向前升級，補會員 version、工作取消理由、通訊時間與狀態保護，並維持歷史可追溯。 | migration guard、資料表重建與複製、舊不合規狀態降為未完成、不得捏造證據或理由、更新後 triggers。 | 空白鏈與 legacy 0001 升級、`foreign_key_check`、約束正反例。 | 測試來源存在；部分結果由本機 API 證據間接觀察。 |
| `0003_assignment_role_integrity.sql` | 將組織角色與事件角色的相容規則放到資料層。 | 升級前若有不相容 active assignment 就停止；新增不相容指派被拒絕；會員降權或停用不能留下不相容 active assignment。 | 相容／不相容指派、會員角色變更、legacy 資料 fail-loud、`foreign_key_check`。 | 2.2.0 測試來源存在；需保存最終執行結果。 |
| `0004_service_lifecycle_accountability.sql` | 為之後的服務淘汰與重新啟用保存原因、操作者、request ID、時間與逐次歷史。 | 狀態改變要求 8-1000 字原因、合格 active admin／commander、request ID 與時間；trigger 新增 append-only lifecycle event；狀態未改時 metadata 不可改寫；不替舊淘汰資料補造理由。 | 缺理由、錯誤 actor、改寫 metadata／歷史、淘汰／重新啟用 round-trip、事件列及 legacy 升級。 | 2026-07-31 本機 migration suite 最終 16/16 通過；先前資料表查核修正後為 15/15，本次再加入 Sites 單一 SQL statement 分段契約。這不等於正式環境 migration 證據。 |

資料庫實際狀態以已套用 migration 與 D1 schema 查詢為準；`db/operations-schema.ts` 是應用程式端對照，兩者不一致時必須停止發布並找出原因，不能任選一份解釋。

## 3. 從錯誤回到需求的查核方式

1. 從 API `requestId` 找 request telemetry 與 `ops_audit_events`。
2. 從 `problemCode` 找到 handler 的驗證或 D1 trigger／check。
3. 從資源 ID 找事件、工作、通訊、指派或檢討的 version 與時間軸。
4. 從本表找到對應 AC 編號、測試與證據限制。
5. 修正後重跑原失敗案例、相鄰負例、migration 或端對端流程；更新證據狀態，而不是只改文件文字。
