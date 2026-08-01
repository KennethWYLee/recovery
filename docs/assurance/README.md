# Continuity Ops 品質保證說明

本目錄保存 Continuity Ops 的內部驗證基準、證據狀態與發布限制。這些資料不屬於產品使用介面，也不得由產品 API 輸出評分項目、配分、級距或個人成績判斷。

## 文件邊界

- [`rubric-v1.16-crosswalk.md`](rubric-v1.16-crosswalk.md)：將內部交付證據對應至 G1–G8 與 P1–P4。
- [`verification-plan.md`](verification-plan.md)：定義驗證次序、關卡、輸出與停止條件。
- [產品設計基準](../product-design.md)：產品資訊架構、互動原則與設計限制；不是實作或驗證證據。
- [`../security-model.md`](../security-model.md)：資產、信任邊界、威脅、控制與未完成項目。
- [`../operations-runbook.md`](../operations-runbook.md)：發布、回復、備份還原、身分與 bootstrap 設定變更及營運事件處理步驟。

## 證據狀態

| 狀態 | 定義 |
|---|---|
| `proposed` | 已寫下要求或計畫，尚未實作。 |
| `implemented` | 已有可對回的程式或設定，不代表已測試。 |
| `verified_local` | 指定版本在本機的明確檢查已通過。 |
| `verified_local_controlled` | 指定版本在受控本機環境的演練或觀察已完成；不能推廣成遠端或 production 結論。 |
| `verified_local_agent_designed` | 未參與功能實作的 agent 依事前凍結案例完成本機黑箱查核；不是外部人員、委託第三方或正式獨立 QA。 |
| `verified_ci` | 不可變 source commit 已在 CI 通過指定關卡，並有 run ID 及 artifact digest。 |
| `verified_staging` | 指定 artifact 已在 staging 套用 migration 並通過遠端驗證。 |
| `verified_external` | 符合事前條件的外部目標使用者已完成任務，且可追溯到版本與原始分母。 |
| `approved_release` | 上述必要證據完整，且有具名 go/no-go 決定。 |

實作、測試、部署、外部使用與核准是不同狀態，不會自動累加。本機測試通過不能改寫為正式環境已驗證；計畫也不能改寫為外部使用結果。`passed_with_documented_limits` 是結果描述，不代表環境、獨立性或外部使用資格。

## 目前可支持的聲明

- 子專案已有本機建置與測試指令；`demo-recovery-lab/.github/workflows/ci.yml` 只是未來拆成獨立 repository 時可採用的 workflow 定義。
- 本系統以獨立 repository 發布，workflow 位於 Git root；只有能對回 source commit 的成功 run ID 與 artifact digest，才構成 `verified_ci` 證據。
- 是否通過必須以當次的 commit、CI run、artifact digest 與實際輸出判定，不可使用舊報告代替。
- 既有完整 API、agent 黑箱、短時負載、telemetry、瀏覽器與資料庫復原證據綁定 Worker SHA-256 `e725a8a8c1cb9b0b41a1b478e6ad0ca6b11c515d673e051ced27c6c92429cedd`。新的校內角色選擇 runtime-bootstrap 證據另綁定 SHA-256 `af852b995266c853facb3d198bd8667198b62c6a7ca6431e35d1152508127286`；兩組 artifact 證據不得混用。
- Gherkin 的 10 個情境、35/35 steps 已通過；另有 6/6 個手工設計規則故障被對應情境抓到。後者只涵蓋六項選定風險，不是完整 mutation campaign、所有需求或獨立人類 QA。
- clean-room 已對 Git 判定無變更且不含 ignored input 的 97 個來源檔執行 18 個命令，均 exit 0，API 71/71；manifest 已盤點 15/15 份預期證據。這仍是本機複本，不是獨立 remote clone 或 CI；vinext digest 也不能證明 bit-for-bit 可重現。本機合成 D1／身分不涵蓋 hosted identity、外部服務或外部使用者。
- 目前不宣稱已部署、已完成正式獨立人類 QA、獨立資安查核、完整 WCAG 2.2 AA、遠端還原、RTO／RPO、production 容量或外部使用驗證。

## 目前實作事實與新契約

下表記錄可對回 source 與 migration 的行為；每項是否通過本機、CI、staging 或外部驗證，仍須依受驗版本另行判定。新的身分政策已有範圍受限的隔離本機 Worker／D1 結果，但不等於 hosted identity edge 或 production 已驗證。

| 範圍 | 可對回的目前行為 | 不代表什麼 |
|---|---|---|
| 復原門檻 | `monitoring → resolved` 由 D1 trigger 檢查復原判定條件、本次監控週期的 verification，以及所有 critical 工作已完成或取消 | 不代表外部監控資料正確或服務已在 production 復原 |
| 驗證與工作證據 | `verification` 時間軸有 HTTPS reference、source label、觀測起訖與選填 SHA-256 digest；工作建立及未完成時證據可空白，但改為 completed 前 API 與 D1 都要求合法 HTTPS evidence reference | 不保存原始 Log，不擷取或驗證外部連結內容，也不表示工作完成狀態足以證明成果正確 |
| 結構化通訊 | 通訊依 draft、reviewed、published 保存；只有草稿可編輯，已核准內容不得改寫，已發布紀錄不可更新或刪除；外部受眾在核准前必須有未來更新時間或獨立 `[FINAL]` 標記，發布時會再次檢查 | `published` 只是系統內狀態；不代表外部狀態頁、Email 或訊息平台已傳送或送達 |
| 事後檢討 | 僅在 resolved／closed 支援 draft、completed、optimistic version；重新開啟會把 completed 退回 draft 並留下紀錄 | 不代表根因已由獨立人員確認 |
| 服務生命週期 | active／deprecated、不可變 slug、版本控制；有未結案事件時不得淘汰；2.2.0 介面要求專用確認與 8–1000 字原因，API 要求 `lifecycleConfirmed: true`，D1 保存操作者、request ID、時間及不可更新／刪除的逐次歷程；本機桌面與窄螢幕流程已核對 | 不代表真實裝置、遠端 API 或正式獨立 QA 已驗證，也不代表已接入服務遙測或 owner-scoped authorization；舊淘汰資料不補造理由 |
| 事件指派 | active／revoked 軟撤銷；最後一位事件指揮官需在同一批次完成合格接任 | 不代表值班排程或外部通知已整合 |
| 身分與權限 | `source_confirmed`；`CO-VRF-RUNTIME-BOOTSTRAP-001` 為 `verified_local_controlled`：精確校內網域帳號的並行首次請求只建立一份會員與稽核；回傳 `commander`、`responder`、`observer`、`auditor` 四個選項且不含 `admin`；拒絕自選管理員，完成 `commander → observer` 切換並確認伺服器權限同步；唯讀角色 5/5 讀取、4/4 method 拒絕、成員目錄 403、稽核 email 省略；既有 admin、其他網域與 suspended 邊界維持 | 只驗證直接提供 forwarded header 的隔離本機 Worker 與合成 D1；正式 hosted edge、完整事件責任組合與 admin actor email 仍待查核 |
| 冪等 | 回執保存 24 小時，相同 payload replay、不同 payload 拒絕，後續寫入執行每批最多 100 筆的過期清理 | 不代表所有遠端競態與中途失敗已驗證 |
| 遙測 | API 發出有界 route template、request ID、狀態、問題代碼、延遲及 API／schema／deployment version 的 JSON telemetry；服務遙測缺漏時回傳 unknown／unavailable／null | 不代表已接 SIEM、告警或 production 服務健康資料 |
| 畫面更新與導覽 | 畫面可見且沒有寫入進行時，選取事件明細、時間軸與通訊每 8 秒輪詢，總覽每 30 秒輪詢；`view`、`incident`、`tab` 可還原畫面位置與前進、後退 | 不代表即時推播、外部通訊送達或 URL 可繞過伺服器授權 |
| 高風險操作確認 | 事件狀態、角色撤銷／交接、工作完成／取消、成員降權／停用、服務淘汰／重新啟用及通訊核准／標記發布已有確認、風險提示或理由欄位 | 前端確認不是授權控制；所有流程仍須接受 API 與 D1 檢查。本機單一瀏覽器引擎已有指定流程核對；真實裝置、跨瀏覽器、遠端與正式獨立 QA 尚待驗證 |
| 組織時區 | D1 保存 IANA 時區，API 回傳後用於顯示、截止時間、通訊排程及證據時間輸入；無效值採 UTC，DST 無效／重複地方時間會拒絕 | 尚待跨時區瀏覽器流程驗證；時區一致不代表外部系統時鐘已同步 |

`CONTINUITY_OPS_DEPLOYMENT_VERSION` 未設定時，結構化 request telemetry 會標示 `unversioned`。本機可使用明確開發標記；staging／production 必須將 `unversioned` 視為發布停止條件。

目前仍未完成邊緣 rate limiting、服務生命週期歷程以外清單的 cursor pagination、真實服務健康遙測、外部狀態頁／Email／訊息平台整合、真實裝置／跨瀏覽器／遠端／正式獨立 QA、遠端備份還原與 rollback 演練、production identity edge 防偽及校內角色選擇的遠端查核、CSP nonce／hash 收斂、資料匯出 API、production 容量／壓力／soak／SLO、外部使用驗證、正式 SAST／DAST／滲透測試及獨立安全／完整可及性查核。其他清單的固定筆數上限、輪詢、source 內已有控制、本機短時負載或本機受控還原不能改寫為上述能力已完成。

## 設計參考

- [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final)：網路安全事件應變與 CSF 2.0 風險管理的建議。
- [Google SRE Incident Management Guide](https://sre.google/resources/practices-and-processes/incident-management-guide/)：事件準備、協調、溝通、控制與事後學習的實務參考。
- [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release)：Web 應用程式安全驗證要求的穩定版。
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)：Web 內容可及性的 W3C Recommendation。

這些文件是設計與驗證參考，不是 Continuity Ops 已通過認證或符合全部要求的證據。
