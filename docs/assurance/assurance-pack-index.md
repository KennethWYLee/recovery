# Continuity Ops 保證文件索引

版本：`1.0.0`  
建立日期：2026-07-31  
對照基準：`評分標準_v1.16.pdf`、Continuity Ops `2.2.0`、資料庫 schema `0004`

## 文件用途

這套文件補足「需求、架構與驗證證據能否互相核對」的查核路徑。它不改寫既有產品文件，也不把尚未執行的 QA、外部使用或個人演練寫成已完成。

指定的評分 PDF 在檔名上為 v1.16，頁尾仍標示 `v1.16-draft` 與「尚待系內核准」。本套文件依其目前內容對照，但不代表該評分制度已完成正式核准。

本系統以獨立 repository 發布，CI workflow 位於 Git root 的 `.github/workflows/`，會在 `main` push 與 pull request 觸發。只有可對回 source commit 的成功 run ID 與 artifact digest，才可標示為 `verified_ci`。

## 證據狀態

| 狀態 | 意義 |
|---|---|
| `verified_local` | 已在指定的本機版本與環境執行，並保留可核對結果。不能推廣成正式環境結論。 |
| `verified_local_controlled` | 已在受控本機環境完成演練或觀察；不能推廣成遠端或 production 結論。 |
| `verified_local_agent_designed` | 未參與功能實作的 agent 依事前凍結案例完成本機黑箱查核；不是外部人員、第三方或正式獨立 QA。 |
| `verified_ci` | 不可變 source commit 已在實際 CI run 通過指定關卡，且可對回 run ID 與 artifact digest；目前尚無此狀態。 |
| `source_confirmed` | 已從程式、migration 或設定確認有該設計；尚不能只靠閱讀原始碼宣稱執行成功。 |
| `generated_local` | 已產生清單或雜湊，但清單本身不證明功能正確。 |
| `planned_template` | 只有事前程序與空白紀錄，尚無受測結果。 |
| `not_verified` | 尚無足以支持主張的證據。 |
| `stale` | 受驗版本或相關內容已變更，舊結果不能直接代表目前版本。 |

## 建議閱讀順序

1. [驗收契約](acceptance-contracts.md)：說明系統服務誰、解決什麼問題，以及每項功能何時才算完成。
2. [系統環境與元件](../architecture/system-context-and-components.md)：說明每個元件的責任與信任邊界。
3. [資料模型](../architecture/data-model.md)：以 ERD 與資料規則說明資料如何關聯。
4. [核心請求與資料流程](../architecture/core-request-sequences.md)：從操作、API、授權、資料庫到稽核紀錄逐步對照。
5. [需求追溯矩陣](requirement-traceability.md)：從驗收編號追到程式、migration、測試及目前證據。
6. [失效情境](../architecture/failure-modes.md)：列出系統可能失效的方式、目前控制及剩餘風險。
7. [設計決策紀錄](../architecture/decision-records.md)：說明重要取捨、替代方案與後果。
8. [證據狀態登錄](evidence-status-register.md)：集中列出已驗證、僅確認設計及尚未驗證的項目。
9. [本機驗證與營運證據工具](operational-evidence-tools.md)：Gherkin、品質指標、故障注入、黑箱、短時負載、故障恢復、telemetry、D1 還原及 clean-room 的指令與限制。
10. [2026-07-31 本機驗證紀錄](local-verification-record-20260731.md)：保存實際執行指令、結果、失敗與重跑，以及 clean-room／manifest 的有界限結果。
11. [獨立 QA 程序](independent-qa-protocol.md)：G7 的事前計畫與空白執行紀錄。
12. [外部專業使用者驗證程序](external-professional-validation-protocol.md)：G8 的招募、任務、結果分析、修正與相同任務重測格式。
13. [四位組員個人證據格式](personal-evidence-templates.md)：P1-P4 的個別證據、實質版本區間與現場診斷演練格式。

## 與受評項目的查核入口

| 項目 | 先讀文件 | 現在能支持的程度 |
|---|---|---|
| G1 目標對象、問題與驗收條件 | [驗收契約](acceptance-contracts.md)、[需求追溯矩陣](requirement-traceability.md) | 需求、範圍、負向條件與完成定義已編號；執行證據仍依各契約狀態判斷。 |
| G3 架構、資料流與責任邊界 | [系統環境與元件](../architecture/system-context-and-components.md)、[資料模型](../architecture/data-model.md)、[核心請求與資料流程](../architecture/core-request-sequences.md)、[設計決策紀錄](../architecture/decision-records.md) | 已能從圖與決策對回 source／migration；正式部署邊界仍未驗證。 |
| G7 整合、端對端與受控 QA | [本機驗證紀錄](local-verification-record-20260731.md)、[獨立 QA 程序](independent-qa-protocol.md) | 已有 71/71 API、12/12 agent 設計黑箱、590/590 短時唯讀負載、同一 Worker 的內部瀏覽器結果，以及 97 個來源檔／18 個命令的 clean-room 結果；本輪未重跑兩分頁輪詢。正式獨立人類 QA 仍為 `planned_template`。 |
| G8 外部使用情境下的系統可靠性 | [外部專業使用者驗證程序](external-professional-validation-protocol.md) | `planned_template`；沒有外部專業使用結果。 |
| P1–P4 個人能力 | [四位組員個人證據格式](personal-evidence-templates.md) | `planned_template`；必須逐人填寫並現場查核。 |

完整 G1–G8／P1–P4 內部對照仍以 [`rubric-v1.16-crosswalk.md`](rubric-v1.16-crosswalk.md) 為入口。文件齊全不會自動換成分數；委員仍要核對內容、執行結果與現場能力。

## 使用規則

- 先固定 source commit、artifact digest、migration、測試資料與環境，再開始記錄結果。
- 一份證據只支持它實際檢查的主張。例如，本機 API smoke 不代表正式身分整合、外部使用可靠性或完整資安查核。
- 學生、測試者與委員都不得在空白模板中預填成功數字。
- 任何會影響需求、程式、migration、設定、測試或使用流程的變更，都要重新判斷哪些舊證據已過期。
- G7 與 G8 的紀錄必須保留失敗、放棄、重試、提示與排除資料，不能只保留成功案例。
- P1-P4 必須逐人判斷。團體文件、自動測試、AI 產出、commit 數或程式行數不能直接證明個人能力。

## 目前不能宣稱的事項

這套文件本身不能證明正式獨立 QA、正式部署、外部專業使用者驗證、獨立資安查核、遠端／production 備份還原、RTO、RPO、production 容量／壓力／soak／SLO 或完整 WCAG 2.2 AA 查核已完成。目前只有受控本機的短時唯讀負載、資料庫未就緒後恢復、D1 logical export/import 與單一瀏覽器引擎／Axe 選定規則結果；其餘項目只有在填妥對應紀錄、保留原始證據並完成必要重測後，才能改為已驗證。
