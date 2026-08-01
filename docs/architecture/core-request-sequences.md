# Continuity Ops 核心請求與資料流程

文件版本：`1.0.0`  
狀態：`source_confirmed`。校內帳號建立、角色選項、管理員排除與角色切換已有隔離本機 Worker／D1 的 `verified_local_controlled` 結果；正式身分邊界仍須以實際第二個 NTUB 帳號確認。

## 1. 正式身分解析與校內角色選擇

```mermaid
sequenceDiagram
    actor U as 使用者
    participant E as 平台身分邊界
    participant A as 身分與權限
    participant D as D1
    participant R as 角色選擇
    participant H as API handler

    U->>E: 登入
    E->>A: 已驗證 Email 與顯示名稱
    A->>D: 先查既有使用者與會員資格
    alt 已有會員資格
      D-->>A: 原角色與狀態
      alt 會員為 active 且角色為 admin
        A-->>R: 管理員由系統指派；不顯示選項
      else 會員為 active 且非 admin
        A-->>R: 目前角色與會員版本
      else 會員為 suspended
        A-->>U: 403；不自動恢復
      end
    else 尚無會員資格
      A->>A: 正規化並比對精確 @ntub.edu.tw
      alt 精確校內網域
        A->>D: 建立啟用中唯讀會員
        D-->>R: 目前角色與會員版本
      else 其他、相似或子網域
        A-->>U: 403；不建立會員
      end
    end
    alt 可選角色
      R-->>U: commander／responder／observer／auditor
      U->>R: 選擇角色與目前版本
      R->>D: 查核版本與啟用中事件責任相容性
      alt 查核通過
        D-->>R: 更新會員角色並寫入稽核
        R-->>H: 依新角色建立 request context
      else 版本過期或責任不相容
        R-->>U: 409；不變更角色
      end
    end
```

`admin` 不在可選角色清單中，自選 API 也會拒絕該值。`observer` 與 `auditor` 的存取政策回應只包含本人，不包含成員目錄；其稽核回應不包含 actor email。這些限制與角色切換都在伺服器端執行，不能只靠畫面隱藏欄位或按鈕。

## 2. 一般寫入請求

```mermaid
sequenceDiagram
    actor O as 維運人員
    participant UI as React 操作介面
    participant W as Worker
    participant R as API route
    participant A as 身分與權限
    participant H as API handler
    participant D as D1
    participant L as 平台 Log

    O->>UI: 送出操作
    UI->>W: 同源 JSON + Idempotency-Key
    W->>R: 轉交請求並補安全標頭
    R->>R: 產生 request ID
    R->>A: 驗證 Origin、身分、會員
    A->>D: 查啟用使用者、會員、組織
    D-->>A: actor 與組織角色
    A-->>H: 已驗證 request context
    H->>H: 檢查權限、事件角色、輸入、資源關係與 expectedVersion
    H->>D: 查未過期冪等回執
    alt 相同 key 與相同 payload 已成功
      D-->>H: 原回應
      H-->>R: replayed = true
    else 新請求
      H->>D: 原子 batch：回執 + 業務更新 + 時間軸 + 稽核
      alt 所有約束成立
        D-->>H: 成功
        H-->>R: 資源與新版本
      else 權限、版本、狀態或資料約束失敗
        D-->>H: 交易失敗
        H-->>R: 穩定問題代碼
      end
    end
    R-->>W: JSON 或 RFC 7807 problem + request ID
    R-->>L: 不含 payload 的 request telemetry
    W-->>UI: no-store 回應與安全標頭
    UI-->>O: 顯示新狀態或可處理錯誤
```

錯誤處理重點：API route 的 telemetry 失敗不能改變原回應；可信 actor 已建立後的特定 mutation 拒絕會嘗試另存 payload-free audit。若該 audit 寫入也失敗，系統另發結構化 error telemetry，但目前沒有正式收集與告警證據。

## 3. 事件解決

```mermaid
sequenceDiagram
    actor C as 事件指揮官
    participant UI as 事件工作區
    participant API as transitionIncident
    participant D1 as D1 transaction
    participant T as 時間軸
    participant A as 稽核

    C->>UI: 要求 monitoring → resolved
    UI->>API: incident ID + expectedVersion + note + key
    API->>API: 檢查組織 incident:command 與事件指揮角色
    API->>D1: 原子狀態更新
    D1->>D1: 檢查目前版本與允許轉換
    D1->>D1: 檢查 verificationCriteria 非空
    D1->>T: 查本次進入 monitoring 後的 verification
    D1->>D1: 查沒有 open／in_progress／blocked critical task
    alt 任一條件不成立
      D1-->>API: 拒絕並回傳對應問題
      API-->>UI: 409 + request ID
    else 三項條件皆成立
      D1->>T: 自動新增狀態時間軸
      D1->>A: 保存成功稽核
      D1-->>API: 新狀態與 version
      API-->>UI: resolved
    end
```

2.2.0 的 migration 正反例與指定 Worker 的 71/71 項 API smoke 已在隔離本機 D1 通過；本機 API 證據綁定 Worker SHA-256 `e725a8a8c1cb9b0b41a1b478e6ad0ca6b11c515d673e051ced27c6c92429cedd`。同一 digest 的內部受控瀏覽器查核涵蓋桌面與手機尺寸、深層連結、鍵盤分頁切換、瀏覽器前進後退，以及 dialog／drawer 焦點；axe-core 選定規則為 0 violation、0 incomplete。本輪未重跑兩分頁輪詢。這些結果只支持明列的本機 API→D1 與瀏覽器流程，不是正式獨立人員 QA、外部使用者證據、完整 WCAG 符合性、自動 E2E、遠端環境或外部服務恢復證據。verification 內容的真實性仍由操作者、獨立 QA 與外部證據查核。

## 4. 通訊審核與標記發布

```mermaid
sequenceDiagram
    actor E as 通訊編輯者
    actor P as 核准者
    participant API as communications API
    participant D1 as D1
    participant X as 外部通訊管道

    E->>API: 建立 audience、message、nextUpdateAt
    API->>D1: 建立 draft
    P->>API: draft → reviewed + expectedVersion
    API->>D1: 檢查核准權限、未來排程或 [FINAL]
    D1-->>P: reviewed
    P->>API: reviewed → published + expectedVersion
    API->>D1: 檢查事件未終止與排程仍有效
    D1-->>P: published
    API--xX: 沒有外部傳送實作
```

`published` 是產品內部狀態。除非日後加入並驗證外部 connector、重試、失敗處理與送達回執，任何報告都不能把它寫成已寄出、已發布到狀態頁或已送達。

## 5. 服務淘汰、重新啟用與歷程查核

```mermaid
sequenceDiagram
    actor M as 管理員或指揮官
    participant UI as 服務目錄
    participant API as services API
    participant D1 as D1 transaction
    participant H as 生命週期歷程

    M->>UI: 選擇淘汰或重新啟用
    UI->>M: 顯示影響、要求原因與明確確認
    M->>UI: 填寫原因並確認
    UI->>API: PATCH status + reason + lifecycleConfirmed + expectedVersion + key
    API->>API: 檢查 service:write、版本、確認、原因與 request ID
    API->>D1: 原子更新服務狀態及 metadata
    D1->>D1: 檢查未結案事件、合格 actor、時間與空白變形
    D1->>H: trigger 新增 append-only 事件
    D1-->>API: 新狀態與 version
    API-->>UI: 回傳服務與 request ID
    UI->>API: GET lifecycle-events + 選填 cursor
    API->>H: 依 changed_at、id 穩定倒序讀取 25+1 筆
    H-->>API: 本頁資料與下一頁邊界
    API-->>UI: events、hasMore、nextCursor
```

狀態未改時不能單獨改寫生命週期 metadata；歷程列不能更新或刪除。舊淘汰資料沒有原始理由時保持空值，日後真實重新啟用才新增第一筆事件。0004 migration、簽章 cursor 單元案例及指定 2.2.0 API artifact 的多頁讀取已在本機通過；內部桌面瀏覽器也已核對 25+2 分頁與高風險確認。遠端、行動裝置與獨立 QA 仍未驗證。

## 6. UI 讀取與更新

- `/operations?view=incidents&incident=...&tab=...` 將選取狀態保存在 URL，重新整理及瀏覽器前進／後退可還原。
- 畫面可見且沒有 mutation 進行時，選取事件明細採約 8 秒週期查詢，總覽採約 30 秒週期；頁面重新可見時會再讀取。
- 這是週期性查詢，不是即時推播。QA 應記錄實際觀察延遲，不得只寫「即時更新」。
- 深層連結只保存 UI 選取資訊；資料是否可讀仍由 API 身分、組織與事件授權決定。

## 7. request ID 如何串起證據

同一 mutation 的 request ID 應出現在 API 回應 header／body、request telemetry、成功或可判定拒絕的 audit，以及部分時間軸事件。診斷時先用 request ID 縮小範圍，再核對 actor、route template、問題代碼、資源 version、時間軸與 D1 狀態。不得把 request body 或秘密加入 Log 來換取方便。
