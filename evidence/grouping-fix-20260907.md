# 建立分組失敗修正

日期：2026-09-07。狀態：本機已修正並驗證，尚未提交、推送或部署。

## 問題與原因

使用者在 test 課程建立 2 組時收到「課程資料目前無法處理，請稍後再試。」正式站紀錄顯示課堂 PATCH 回傳 500；其中一筆 request ID 為 `req-f3834e6f-8f27-4a5d-b37a-15d6aaa4e8d5`。正式站紀錄未保存底層資料庫錯誤訊息，因此原因另以程式、遷移檔及隔離測試查核。

新課堂的 `group_capacity` 預設為 20。分組原本將 `effective_group_capacity` 改為實際最大組員數，違反資料庫要求該值不小於 `group_capacity` 的限制。2 人分 2 組時，原值被改成 1，導致整批交易失敗。本機原有建置透過新增的正式 API 測試重現相同 500 與錯誤代碼。

## 修改

- `db/classroom-live.ts`：容量更新使用 `MAX(group_capacity, ?)`，維持既有容量限制；實際分組仍按指定組數平均分配。
- `scripts/verify-classroom-grouping.mjs`：新增隔離測試，透過正式 API 建立課程、課堂及分組，核對人數、代表、版本、重新讀取與重複請求。
- `scripts/run-classroom-api-simulation.mjs`：將新增案例納入既有 API 演練。
- `evidence/api-simulation/latest.json`：由測試程式重新產生。

未修改資料庫結構、正式課堂資料或網站權限。測試資料全部為本機隔離的虛擬資料。

## 驗證

- 修正前 `npm run test:api-simulation`：2 人／2 組案例重現 500 `CLASSROOM_SERVICE_ERROR`。
- 修正後相同指令：通過；288 個請求、0 個非預期失敗。
- 分組案例：2 人／2 組為 1、1；7 人／6 組為 2、1、1、1、1、1；41 人／2 組為 21、20（隨機組別順序可能不同）。
- 人數不足回傳 409；每人只分到一組；每組一位組內代表；舊版本重送回傳 409 且只有一筆分組稽核紀錄。
- `npm run gate:static`：型別、lint、程式品質檢查通過。
- `npm run test:workflow`：17/17 通過。
- `npm run test:unit`：77/77 通過。
- `npm run build`：成功。
- `npm run test:integration`：4/4 通過。

API 演練在刻意取消讀取時有 Windows workerd 連線中止訊息；後續恢復檢查與整體演練均通過。未另跑完整 mutation、coverage、依賴稽核或線上瀏覽器操作測試。正式站尚未部署或重測，不把本機結果當成正式站已修復的證據。

查閱：`PROJECT.md`、`README.md`、課程與課堂 API、分組實作、`classroom-schema.ts`、既有遷移與測試程式，以及 Sites 正式站錯誤紀錄。未建立 commit。
