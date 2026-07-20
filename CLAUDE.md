# Kangentic Fork 工作指引

本檔只保留跨任務、穩定且代價高的護欄。工作前先讀與任務直接相關的程式、測試和文件。

## Fork 治理

- Fork 的角色、分支拓撲、上游同步與發布界線以 [docs/fork-governance.md](docs/fork-governance.md) 為準。
- `main` 是上游鏡像。個人 fork 工作在治理文件定義的分支，不把個人流程或未核准變更帶入乾淨的 `main`。
- `.claude` 在此 fork 中是刻意移除的目錄。不得還原、建立，或把它當作指令或 workflow 的來源。

## 授權與安全

- 此 fork 僅以 `AGPL-3.0-only` 發布。每個對外傳遞的建置產物都必須一併提供 `FORK-NOTICE` 與對應、可取得的完整來源。
- 不得寫入、展示或提交 secrets、tokens、credentials、private keys、使用者名稱、電子郵件或個人機器路徑。
- Commit、push、建立或更新 PR、merge、tag 與 release 都必須先取得明確授權。沒有授權時，只可準備變更與驗證結果。

## 來源與驗證

- `package.json` 是 scripts 與相依套件的唯一來源。
- 測試分層、環境設定與手動驗證方式以 [docs/developer-guide.md](docs/developer-guide.md) 為準。
- 系統邊界與資料流以 [docs/architecture.md](docs/architecture.md) 為準。
- Fork 的貢獻、同步與發布決策以 [docs/fork-governance.md](docs/fork-governance.md) 為準。
- 可執行的測試、ESLint 與 CI 是行為與品質要求的權威證據。文件與程式衝突時，先查程式和 CI 設定，再更新文件。

## 測試範圍

迭代時只執行新增、修改或直接受影響的單一測試，完整測試交給 CI 或明確要求的手動驗證。

可自由執行：

- `npm run typecheck`
- `npx vitest run tests/unit/my-new.test.ts`
- `npx playwright test tests/ui/my-new.spec.ts`
- 直接受影響的既有單一測試，使用相同的帶檔案路徑形式

除非使用者明確要求，禁止執行：

- `npm test`
- `npm run test:unit`
- `npx vitest run`
- `npx playwright test`
- `npx playwright test --project=ui`

## Worktree 與跨平台

- 受管理的 worktree 通常會連結既有 `node_modules`。只有連結不存在，或明確停用連結時，才在該 worktree 執行 `npm install`。
- Windows、macOS 與 Linux 的行為必須一致。不得硬編 OS 路徑或假設單一 shell、檔案鎖定或時序行為。

## 不可破壞的工程邊界

- DB 寫入時間戳一律使用 `new Date().toISOString()` 的 UTC ISO 8601 字串，不能使用 SQLite 預設時間或未標示時區的字串。
- Renderer 發起的 task 或 session mutation 必須傳遞互動當下的明確 `projectId`。
- 每個 task 的非同步 mutation 必須包在 `withTaskLock` 中。
- 所有 agent spawn 入口必須經過 `spawnAgent` 或 `prepareAgentSpawn`，並共用 `runSpawnPreamble`。不得在 handler 或 transition engine 直接 spawn。
- Agent 名稱分支只能存在於 `src/main/agent/adapters/`。其他層只能依賴 adapter 契約。
- `before-quit` 的 shutdown 路徑必須同步完成。
