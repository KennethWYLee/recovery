# Continuity Ops 資料模型

文件版本：`1.0.0`  
狀態：依 `db/operations-schema.ts` 與 migration `0001` 至 `0004` 整理。實際 D1 以已套用 migration 及 schema 查詢為準。

## 1. ERD

```mermaid
erDiagram
    OPS_ORGANIZATIONS ||--o{ OPS_MEMBERSHIPS : contains
    OPS_ORGANIZATIONS ||--o{ OPS_SERVICES : owns
    OPS_ORGANIZATIONS ||--o{ OPS_SERVICE_LIFECYCLE_EVENTS : records
    OPS_ORGANIZATIONS ||--o{ OPS_INCIDENTS : owns
    OPS_ORGANIZATIONS ||--o{ OPS_AUDIT_EVENTS : records
    OPS_ORGANIZATIONS ||--o{ OPS_IDEMPOTENCY_RECEIPTS : scopes

    OPS_USERS ||--o{ OPS_MEMBERSHIPS : joins
    OPS_USERS ||--o{ OPS_SERVICES : owns
    OPS_USERS ||--o{ OPS_SERVICE_LIFECYCLE_EVENTS : changes
    OPS_USERS ||--o{ OPS_INCIDENT_ASSIGNMENTS : receives
    OPS_USERS ||--o{ OPS_INCIDENT_TIMELINE : acts
    OPS_USERS ||--o{ OPS_INCIDENT_TASKS : is_assigned
    OPS_USERS ||--o{ OPS_INCIDENT_COMMUNICATIONS : authors_reviews_publishes
    OPS_USERS ||--o{ OPS_POST_INCIDENT_REVIEWS : authors
    OPS_USERS ||--o{ OPS_AUDIT_EVENTS : acts
    OPS_USERS ||--o{ OPS_IDEMPOTENCY_RECEIPTS : retries

    OPS_SERVICES ||--o{ OPS_INCIDENTS : experiences
    OPS_SERVICES ||--o{ OPS_SERVICE_LIFECYCLE_EVENTS : has_history
    OPS_INCIDENTS ||--o{ OPS_INCIDENT_ASSIGNMENTS : staffs
    OPS_INCIDENTS ||--o{ OPS_INCIDENT_TIMELINE : records
    OPS_INCIDENTS ||--o{ OPS_INCIDENT_TASKS : contains
    OPS_INCIDENTS ||--o{ OPS_INCIDENT_COMMUNICATIONS : contains
    OPS_INCIDENTS ||--o| OPS_POST_INCIDENT_REVIEWS : has

    OPS_ORGANIZATIONS {
      text id PK
      text name
      text timezone
      text status
    }
    OPS_USERS {
      text id PK
      text email UK
      text display_name
      text identity_source
      text status
    }
    OPS_MEMBERSHIPS {
      text id PK
      text organization_id FK
      text user_id FK
      text role
      text status
      integer version
    }
    OPS_SERVICES {
      text id PK
      text organization_id FK
      text slug UK
      text tier
      text owner_user_id FK
      real slo_target
      text runbook_url
      text status
      text status_change_reason
      text status_changed_at
      text status_changed_by_user_id FK
      text status_change_request_id
      integer version
    }
    OPS_SERVICE_LIFECYCLE_EVENTS {
      text id PK
      text organization_id FK
      text service_id FK
      text from_status
      text to_status
      text reason
      text changed_by_user_id FK
      text request_id UK
      text changed_at
    }
    OPS_INCIDENTS {
      text id PK
      text organization_id FK
      text incident_number UK
      text service_id FK
      text severity
      text status
      text verification_criteria
      integer version
      text last_request_id
    }
    OPS_INCIDENT_ASSIGNMENTS {
      text id PK
      text incident_id FK
      text user_id FK
      text incident_role
      text status
      text ended_at
    }
    OPS_INCIDENT_TIMELINE {
      text id PK
      text incident_id FK
      text event_type
      text actor_user_id FK
      text request_id
      text reference_url
      text sha256_digest
      text created_at
    }
    OPS_INCIDENT_TASKS {
      text id PK
      text incident_id FK
      text assignee_user_id FK
      text priority
      text status
      text evidence_ref
      text cancellation_reason
      integer version
    }
    OPS_INCIDENT_COMMUNICATIONS {
      text id PK
      text incident_id FK
      text audience
      text status
      text next_update_at
      integer version
      text last_request_id
    }
    OPS_POST_INCIDENT_REVIEWS {
      text id PK
      text incident_id FK UK
      text status
      integer version
    }
    OPS_AUDIT_EVENTS {
      text id PK
      text actor_user_id FK
      text action
      text resource_type
      text resource_id
      text outcome
      text reason_code
      text request_id
    }
    OPS_IDEMPOTENCY_RECEIPTS {
      text id PK
      text actor_user_id FK
      text action_scope
      text idempotency_key_hash
      text request_hash
      text expires_at
    }
```

`ops_write_guards` 是交易內短暫使用的版本／存在性斷言表，沒有業務實體關係，因此未放入主要 ERD。它只允許 `passed = 1`，batch 結束前會刪除對應列；斷言不成立會使整批寫入失敗。

## 2. 資料責任

| 資料群 | 用途 | 重要不變條件 |
|---|---|---|
| 組織、使用者、會員 | 決定登入後的組織與基礎權限；精確 `@ntub.edu.tw` 的無會員帳號可在首次登入建立唯讀會員。 | Email 唯一；一位使用者在組織內只有一筆會員；既有會員優先且 `suspended` 不復原；自動建立角色只能是 `observer`／`auditor`；最後一位啟用管理員不能失去資格；會員更新需版本加一。 |
| 服務 | 將事件連到負責團隊、重要度、SLO 目標與 Runbook。 | 組織內 slug 唯一且不可變；SLO 目標大於 0 且不超過 100；有未結案事件時不能淘汰；狀態變更要保存原因、合格操作者、request ID 與時間，且不能在狀態未改時改寫。 |
| 服務生命週期事件 | 逐次保存淘汰與重新啟用的前後狀態、原因、操作者、request ID 與時間。 | 每次狀態改變由 trigger 新增；`(service_id, organization_id)` 必須對回同一服務；`(service_id, request_id)` 唯一；事件列不可更新或刪除；不能替 0004 前不存在的歷史理由補造資料。 |
| 事件 | 保存事件編號、服務、嚴重度、狀態、假說、緩解、驗證準則與里程碑時間。 | 組織內事件編號唯一；版本加一；狀態只能依允許路徑；解決前通過三項條件。 |
| 事件指派 | 將啟用會員指派為事件指揮、應變、通訊、服務負責或觀察角色。 | 同一事件／使用者／角色只有一筆 active；撤銷保留 row；最後指揮官須原子交接。 |
| 時間軸 | 保存狀態、調查、緩解、驗證、通訊、工作、指派與檢討事件。 | append-only；同一事件、request ID 與 event type 唯一；驗證欄位格式受 API 檢查。 |
| 工作項目 | 保存事件處理工作、優先度、負責人、期限、完成證據及取消理由。 | 完成必須有合法 HTTPS；critical 取消必須有理由；取消理由一旦保存不能改寫。 |
| 通訊 | 保存內部、利害關係人或公開受眾的草稿、審核與發布標記。 | 建立時只能 draft；reviewed 內容不可改；published 不可改／刪；外部受眾需未來更新或 `[FINAL]`。 |
| 事後檢討 | 保存影響、原因、偵測缺口、學習與後續工作。 | 每個事件最多一筆；未解決事件不可建立；completed 六段皆須達最低內容；重新開啟回到 draft。 |
| 稽核 | 保存可信 actor 的成功、拒絕及可判定失敗。 | append-only；保留 request ID、角色、資源及問題代碼；拒絕紀錄不保存 request payload。 |
| 冪等回執 | 讓逾時重試不重複寫入。 | 組織、actor、action scope 與 key hash 唯一；同 key 不同 request hash 被拒絕；24 小時後才能過期清理。 |

## 3. 核心資料流

以「完成事件工作」為例：介面讀取工作 `version`，送出 task ID、`expectedVersion`、狀態與 HTTPS 證據。API 檢查會員、權限、事件角色、欄位與冪等 key；D1 batch 先建立冪等回執，再用 write guard 確認舊版本仍存在，更新 task、建立時間軸與稽核，最後刪除 guard。任何一步失敗時整批不應留下部分完成狀態。

## 4. 個資與敏感資料

目前資料庫保存 Email、顯示名稱、角色、操作者、自由文字事件紀錄及外部參考 URL。這些可能構成個資、內部營運資訊或敏感事件內容。資料層保留可歸責 actor，但 API 必須對 `observer`／`auditor` 的稽核回應省略 actor email，並將存取政策限制為本人；`admin` 仍可查看 actor email。角色別欄位投影已有隔離本機 Worker／D1 的受控結果；正式邊緣的實際第二個 NTUB 帳號與 admin actor email 仍待查核。產品目前沒有已核准的保存期間、刪除程序、資料匯出、合法依據或正式隱私查核結果。

正式使用前要另行決定：資料蒐集目的、告知與同意、可查看角色、保存期間、刪除及封存責任、備份中的刪除處理、外部連結風險與事件自由文字的敏感資訊指引。

## 5. 一致性查核

每次 migration 後至少要核對：

- `PRAGMA foreign_key_check` 無結果；
- 所有預期 table、index、check 與 trigger 存在，包括 `ops_service_lifecycle_events`；
- 空白資料庫與 legacy 0001 都能向前升級；
- migration 不捏造完成證據、取消理由、檢討內容或舊服務生命週期理由；
- `db/operations-schema.ts` 與實際 D1 欄位、狀態、版本及 service／organization 複合外鍵一致；
- 服務生命週期理由的換行、歸位、tab、vertical tab、form feed 與 NBSP 空白變形不能繞過長度限制；每次真實狀態變更只新增一筆歷程，且歷程不可更新或刪除；
- 直接 SQL 仍無法繞過重大資料不變條件。
