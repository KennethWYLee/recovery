# Continuity Ops 失效情境與處理

文件版本：`1.0.0`  
狀態：風險分析。表中的現有控制來自原始碼、migration 或本機證據；「待驗證」不能寫成已處理完成。

## 1. 失效情境總表

| 編號 | 可能失效方式 | 可能影響 | 如何發現 | 現有預防或限制 | 剩餘工作與證據狀態 |
|---|---|---|---|---|---|
| FM-01 | 正式環境允許用戶端偽造 forwarded identity header | 攻擊者冒用會員或管理員 | 以外部請求嘗試加入相同 header；查 edge 設定與 access log | 應用程式只接受特定 header，未知身分不自動建立會員 | 必須在 private identity edge 做負例；目前 `not_verified`。 |
| FM-02 | 已驗證 Email 被誤認為自動受邀 | 未授權帳號取得資料 | 用未受邀身分登入並查會員資料 | `loadOrProvisionOperationsActor` 只允許既有 active membership 或明確 bootstrap／本機操作員 | 單元設計已確認；正式環境仍待驗證。 |
| FM-03 | 兩位操作者同時更新，後寫覆蓋先寫 | 遺失新資料或決定 | 同時送出相同 `expectedVersion`，觀察第二筆結果 | version 欄位、write guard 與 D1 version triggers | 本機負例已驗證；仍要在 staging 多工作階段重跑。 |
| FM-04 | 網路逾時造成同一 mutation 重送 | 重複事件、角色、工作或通訊 | 使用相同 key 重送，核對筆數與回應 | request hash 綁定的冪等回執、同 scope 唯一索引、先讀回執 | 本機已驗證；正式 24 小時清理與容量監控未驗證。 |
| FM-05 | 多筆寫入只完成一部分 | 資源已更新但缺時間軸、稽核或回執 | 刻意使 batch 中一個 statement 違反 constraint，核對所有資料 | D1 batch、write guard、資料庫 constraint／trigger | migration 來源已涵蓋部分；仍需獨立 QA 保存實際結果。 |
| FM-06 | 事件被越級或由錯誤角色推進 | 未處理風險即被標記完成 | 嘗試非法狀態與不同角色／事件指派組合 | 組織權限加事件角色、狀態圖、API 與 D1 transition guard | 指定本機 API 負例、18/18 個單元套件故障注入及 6/6 個 Gherkin 情境故障注入已驗證；案例為人工挑選，不能視為完整 mutation testing 或 mutation score。 |
| FM-07 | 缺少驗證或 critical 工作未完成就解決事件 | 團隊誤認服務已恢復 | 分別移除驗證準則、本週期證據或保留 critical 工作 | D1 三項 resolution readiness guard、穩定問題代碼 | 本機兩週期案例已驗證；外部證據真實性仍由人員查核。 |
| FM-08 | critical 工作取消而沒有可追溯理由 | 重要風險被靜默略過 | 取消時留空、過短、過長，或同時降級 | API 與 D1 同時檢查原優先度／新優先度；理由保存後不可改 | 本機已驗證。理由品質仍需事件指揮與事後檢討審查。 |
| FM-09 | 未審核通訊被視為已發布，或已發布內容被改寫 | 錯誤訊息、稽核失真 | 嘗試 draft 直發、核准後改文、終止事件發布 | draft→reviewed→published、分權、排程、immutable triggers | 內部狀態本機已驗證；外部傳送未實作。 |
| FM-10 | 操作人員把內部 `published` 當成外部送達 | 利害關係人實際未收到訊息 | 比對外部送達回執；檢查產品是否有 connector | 產品文件與 API 僅承諾內部狀態 | UI 仍需持續使用不誤導文字；任何外部整合須新增明確契約與測試。 |
| FM-11 | D1 不可用、schema 未套用或 binding 錯誤 | 所有讀寫中斷 | `/api/v1/health`、API 5xx、平台錯誤、migration list | health fail-loud、統一 problem response、migration 版本常數 | 正常本機 health 已驗證；遠端 D1 故障、降級與復原演練未驗證。 |
| FM-12 | 拒絕請求後稽核寫入失敗 | 安全事件缺少應用程式稽核列 | `continuity_ops.rejected_mutation_audit_write_failed` telemetry | 保留原拒絕回應，另發不含 payload 的 error telemetry | 正式 Log 收集、告警、值班與保留未驗證。 |
| FM-13 | request telemetry 管線失效 | MTTA／錯誤分析缺資料 | 比對請求數與實際 Log 分母，監測 ingestion lag／drop | 應用程式以結構化 JSON 發出；分析器拒絕未知／敏感欄位並保留明確分母；失敗不影響 API | CO-VRF-TELEMETRY-001 對最終 2.2.0 本機 Log 為 815/815 筆有效：761 筆成功、54 筆受控 4xx、0 筆 5xx；安全負向檢查的 request ID 對應為 44/44，API、schema 與 deployment mismatch 均為 0。目前未接入或驗證託管 collector、ingestion、retention、SLO 與告警，不能外推至正式環境。 |
| FM-14 | Log 或稽核紀錄洩漏秘密／個資 | 憑證或個資暴露 | 搜尋 token、cookie、Authorization、body 與自由文字 | route template、欄位白名單、拒絕 audit 不含 payload | 專案文字來源秘密掃描案例 5/5、93 個檔案無命中；正式 Log 查核、Git history／binary／runtime secret 與保存政策未驗證，時間軸自由文字仍可能含敏感資訊。 |
| FM-15 | HTTPS 證據連結格式正確但內容錯誤、失效或被替換 | 錯誤證據支撐完成／解決 | 獨立開啟、核對來源、觀測窗、digest 與權限 | 保存 URL、來源、時間窗及可選 SHA-256 | 系統不擷取外部內容；必須由 QA 或查核者驗證，並記錄存取限制。 |
| FM-16 | 本地時間位於 DST 不存在或重複區間 | 排程落在錯誤 UTC 時刻 | 使用已知 DST 邊界輸入並 round-trip | IANA 時區、UTC 保存、拒絕不存在／重複地方時間 | 單元測試定義存在；跨時區瀏覽器與正式 D1 round-trip 尚缺持久證據。 |
| FM-17 | UI 深層連結或前端權限顯示被利用繞過授權 | 無權資料被讀取或修改 | 直接呼叫 API、修改 query、使用觀察者角色 | 伺服器每次查身分、會員、組織權限與事件存取 | 本機權限負例已驗證；完整瀏覽器與正式 edge 仍待查核。 |
| FM-18 | 固定 LIMIT 截斷事件、時間軸、稽核或通訊 | 操作人員以為資料完整 | 建立超過上限的資料並檢查提示／翻頁 | 服務生命週期歷程已有簽章 keyset cursor 與載入更多；其他清單仍以固定上限避免無界查詢 | 生命週期多頁 API 與內部桌面瀏覽器 25+2 載入已在同一指定本機 artifact 驗證；失敗重試、行動裝置、遠端與其他固定上限清單仍待查核。 |
| FM-19 | 備份無法還原或 migration 與舊資料不相容 | 事件與稽核資料遺失、長時間中斷 | 隔離還原、`foreign_key_check`、資料筆數／雜湊、應用 smoke | forward-only migrations；CO-VRF-D1-RESTORE-001 已以合成本機資料核對來源與還原端各 15 個資料表、逐表筆數、4/4 migrations、marker、備份雜湊及兩端 FK | 不是遠端或真實資料演練，也沒有 RTO／RPO、D1 Time Travel、併行寫入、產品 artifact 綁定或應用 rollback 證據。 |
| FM-20 | 突發流量或濫用超過 Worker／D1 容量 | 延遲、錯誤或成本異常 | 壓力測試、p95／p99、429／5xx、D1 指標 | 請求 body 以不信任 `Content-Length` 的串流讀取限制為 32 KiB；部分查詢有上限 | 本機 413 案例不代表 hosted edge；rate limiting、容量基準、負載與長時間穩定性未驗證。 |
| FM-21 | 介面鍵盤、焦點、對比或螢幕閱讀器操作失敗 | 部分專業使用者無法完成核心任務 | WCAG 2.2 AA 人工與輔助技術查核 | 語意控制、焦點回復、非只靠顏色及響應式設計來源 | 只有局部人工檢查；不能宣稱完整符合 WCAG 2.2 AA。 |
| FM-22 | 外部使用者需要提示、放棄或反覆重試，但團隊只報滿意度 | 高估真實任務可靠性 | 保存每人每任務的提示、失敗、放棄、重試及 request ID | [外部專業使用者驗證程序](../assurance/external-professional-validation-protocol.md) | 目前只有 `planned_template`，尚無外部結果。 |
| FM-23 | 組織角色被指派不相容的事件角色，或先指派再降權 | 低權限帳號藉事件角色取得寫入能力，或 active assignment 與實際權限矛盾 | 建立所有組織角色 × 事件角色組合；再嘗試降權與停用 | 共用相容矩陣、API／UI 篩選、0003 insert 與 membership update triggers；legacy 不相容資料使 migration 停止 | 已以本機單元測試、migration 測試及指定 Worker 的 API 正反向案例驗證合格指揮官指派與觀察者遭拒；尚未驗證遠端環境的完整角色組合與身分邊界情況。 |
| FM-24 | 服務被淘汰或重新啟用，卻沒有確認、原因、操作者、request ID 或時間，或事後改寫原因 | 生命週期決定無法追溯，可能錯誤停用重要服務 | 未確認、空白變形理由、錯誤角色、無狀態變更改寫 metadata、狀態 round-trip、歷史列更新／刪除 | UI 專用確認；API 要求確認與 8–1000 字原因；0004 驗證 actor／request ID／時間與空白變形，新增 append-only lifecycle event 並保護 metadata；本機 migration suite 最終 16/16 通過 | 指定 2.2.0 artifact 的 API 正反例與內部桌面確認介面已通過；既有 legacy 淘汰列不補造理由，遠端、行動裝置、獨立 QA 與正式 migration 未驗證。 |
| FM-25 | 生命週期歷程翻頁重複、漏資料、接受無效 cursor，或讀到其他服務資料 | 稽核人員誤判決定歷史，或發生跨資源資訊外洩 | 建立超過 25 筆且含同時間事件；逐頁核對唯一 ID 與完整集合；測重複／過長／格式錯誤 cursor 及跨組織、跨服務請求 | 以 `(changed_at, id)` keyset 穩定倒序；HMAC-SHA256 簽章且綁定 organization／service 的 opaque cursor；長度、格式與 scope 檢查 | cursor 單元案例、指定 2.2.0 API artifact 的多頁資料，以及同一 digest 的內部桌面 25+2 載入均已驗證；瀏覽器失敗重試、行動裝置與遠端隔離尚未驗證。 |

## 2. 問題處理順序

發現失敗時依序處理：

1. 先保護正式資料、停止高風險操作或切換到核准的安全狀態；
2. 固定 incident ID、request ID、版本、時間、actor 與重現步驟；
3. 以 Log、稽核、時間軸、API problem、D1 constraint 及資料差異建立可被推翻的原因假說；
4. 先重現，再做最小且可回復的修改；
5. 重跑原失敗情境、相鄰負例與受影響回歸；
6. 若涉及 migration 或部署，再查資料一致性、artifact digest、重新部署或 rollback；
7. 記錄仍未解決的限制與具名決定，不以「已修好」取代證據。

## 3. 發布前不得略過的高風險項目

FM-01、FM-07、FM-09、FM-11、FM-14、FM-19 與任何會造成未授權存取、資料遺失、錯誤結案或外部誤導的問題，在正式環境沒有相稱負例、監控及回復證據前，不應宣稱適合生產使用。
