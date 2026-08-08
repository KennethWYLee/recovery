Feature: 問題修正與回歸驗證
  問題只有在原因、修正版次、測試與成功驗證都可核對時才能結案。

  Scenario: 證據完整的問題可以結案
    Given 管理員已記錄失敗與修正後成功的 Request ID
    When 管理員填寫原因、修正方式、部署版本與回歸測試結果
    Then 系統接受問題結案

  Scenario: 缺少成功驗證的問題不能結案
    Given 管理員只記錄失敗的 Request ID
    When 管理員嘗試將問題標示為已解決
    Then 系統拒絕問題結案
