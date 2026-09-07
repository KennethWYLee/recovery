# 更換發言人後學生仍停在唯讀畫面

- 讀取學生填寫欄位條件、課堂快照、指定代表路由、學生資料隱私處理及背景更新程式。
- 根因：學生收到的 groups 隱藏 representativeUserId，participants 也為空；背景更新 signature 未包含 currentUser.isRepresentative。僅變更代表時，API 回傳的新權限被判定成相同畫面而未套用。
- useWorkspaceLoader.ts 將目前學生的發言人、題目參與及排序權限納入更新判斷。保留隱私處理及伺服器作答限制。
- 在 classroom-workspace-loader.test.mjs 重現匿名學生資料、同組同草稿版本且只變更發言人權限的情況；修正前測試失敗（仍為 false），修正後新發言人切為 true，撤換後切回 false，草稿保留且發言人識別碼仍不公開。
- npm run test:unit：82 項通過；npm run gate:static：通過；npm run gate:build：正式建置及 4 項產物檢查通過。
- 未更改正式學生、回應或題目資料。未操作學生真實手機驗證；未重跑未變動的後端 API 模擬。作答階段且回答仍為草稿的新發言人可看到既有輸入欄位；已截止或已送出的回答不會因換發言人重開。
- 建立本次來源提交並推送原 Sites 來源庫，部署到原正式站。上線後既有學生分頁需重新整理一次取得修正版。
