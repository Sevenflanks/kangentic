# Kangentic Fork 工作指引

本檔只保留跨任務、穩定且代價高的護欄。工作前先讀與任務直接相關的程式、測試和文件。

## Fork 治理

- Fork 的角色、分支拓撲、上游同步與發布界線以 [docs/fork-governance.md](docs/fork-governance.md) 為準。
- `main` 是 upstream 鏡像。個人 fork 工作在治理文件定義的分支，不把個人流程或未核准變更帶入乾淨的 `main`。
- `.claude` 在此 fork 中是刻意移除的目錄，不得還原、建立，或把它當作指令或 workflow 的來源。

## 授權與安全

- 此 fork 僅以 `AGPL-3.0-only` 發布。每個對外傳遞的建置產物都必須一併提供 `FORK-NOTICE` 與對應、可取得的完整來源。
- 不得寫入、展示或提交 secrets、tokens、credentials、private keys、使用者名稱、電子郵件或個人機器路徑。
- 未經明確授權，不得 commit、push、建立或更新 PR、merge、tag 或 release。

## 來源與驗證

- `package.json` 是 scripts 與相依套件的唯一來源。
- 測試分層、環境設定與手動驗證方式以 [docs/developer-guide.md](docs/developer-guide.md) 為準。
- 系統邊界與資料流以 [docs/architecture.md](docs/architecture.md) 為準。
- 文件與程式衝突時，先查程式和 CI 設定，再更新文件。

## 不可破壞的工程邊界

- DB 寫入時間戳一律使用 `new Date().toISOString()` 的 UTC ISO 8601 字串。
- Renderer 發起的 task 或 session mutation 必須傳遞互動當下的明確 `projectId`。
- 每個 task 的非同步 mutation 必須包在 `withTaskLock` 中。
- 所有 agent spawn 入口必須經過 `spawnAgent` 或 `prepareAgentSpawn`，並共用 `runSpawnPreamble`。
- Agent 名稱分支只能存在於 `src/main/agent/adapters/`。
- `before-quit` 的 shutdown 路徑必須同步完成。
