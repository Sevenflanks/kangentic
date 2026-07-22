# OpenCode Windows 多行 Prompt 傳輸設計

## 背景

本設計處理 [GitHub Issue #2](https://github.com/Sevenflanks/kangentic/issues/2)：Kangentic 在 Windows 透過 `opencode.cmd` 啟動 OpenCode 時，多行 Task prompt 最終只剩第一行 `<task>`。

目前 OpenCode adapter 將 prompt 組進 `--prompt "..."` shell command string。PTY 先啟動使用者設定的互動 shell，再把整段 command 寫入 shell。Windows 上的實際邊界可能包含 PowerShell、`.cmd` shim 與 `cmd.exe` 的連續解析。既有 unit tests 只驗證產生的 command 字串，沒有驗證 OpenCode 最終收到的參數，因此無法保證多行 Unicode 與 shell metacharacters 能完整穿越這些邊界。

## 目標

- Fresh OpenCode session 將完整 Task XML 作為第一則 user message。
- Resume OpenCode session 時，先恢復既有 session，再送出本次流程產生的 prompt。
- Resume 不重送原始 Task XML；沒有本次 prompt 時只恢復 session。
- 保留 LF、CRLF 的行界線、繁體中文與其他 Unicode 內容。
- 引號及 `& | < > ^ %` 等 shell metacharacters 不得截斷 prompt，也不得被當成 shell 指令執行。
- 以實際 Windows `.cmd` shim 路徑建立回歸測試。
- 行為變更只套用 OpenCode；其他 adapters 維持目前的 CLI argument prompt delivery。

## 非目標

- 不導入或管理 OpenCode server/session HTTP API。
- 不解析不同安裝來源的 `.cmd` shim 以尋找底層 executable。
- 不重構所有 adapters 的 prompt transport。
- 不變更 Task XML 格式、template interpolation 或 attachment 格式。
- 不新增 UI、通知 channel 或 prompt delivery 持久化 subsystem。

## 已選方案

OpenCode 啟動或恢復時不再把 prompt 放入 command line。Kangentic 等待 OpenCode TUI ready，再透過既有 `TerminalSubmit.submitContent()` 以 bracketed paste 送出完整內容。

此方案直接移除問題中的 shell data boundary。Prompt 不再經過 PowerShell、`.cmd` 或 `cmd.exe` argument parsing，而是成為已啟動 OpenCode TUI 的輸入內容。

## Adapter 契約

`AgentAdapter` 新增明確的 initial prompt delivery capability：

```ts
type InitialPromptDelivery = 'command-argument' | 'terminal-submit';
```

Adapter 可宣告 `initialPromptDelivery`。未宣告時視為 `command-argument`，維持現有 adapters 的行為。`OpenCodeAdapter` 宣告 `terminal-submit`。

共用 spawn 層只依賴 capability，不得以 agent 名稱分支。OpenCode 專屬選擇只存在於 `src/main/agent/adapters/opencode/`。

OpenCode command builder 不再產生 `--prompt`。Fresh command 只包含 executable、agent/model 等啟動設定；resume command 仍使用 `--session <id>`，但不攜帶 prompt。

## Spawn 資料流

`resolveSpawnIntent()` 繼續作為 prompt 語意的單一來源：

- Fresh 且有 task template：`intent.prompt` 是完整 Task XML、attachments 與適用的 handoff prefix。
- Resume：`intent.prompt` 只來自本次 `resumePrompt`，例如 continuation、以 prompt 交付的 auto-command，或其 handoff overlay。
- Resume 且無本次 prompt：`intent.prompt` 為空，不進行 terminal submission。

`executeSpawnAgent()` 依序執行：

1. 解析 fresh 或 resume intent。
2. 保留完整 `intent.prompt` 作為待傳內容。
3. 若 adapter 使用 `terminal-submit`，傳給 `buildCommand()` 的 prompt 為 `undefined`。
4. 啟動或 queue PTY session。
5. 更新 task 並寫入 session record；record 的 `prompt` 仍保存本次原本應傳送的內容。
6. 若待傳內容非空，將 initial-content job 排入 `TerminalSubmitScheduler`。

## Submission 排程

`TerminalSubmitScheduler` 使用 task-keyed 的 discriminated union 管理兩種 job：

```ts
type ScheduledSubmission =
  | { kind: 'content'; text: string; sessionId: string }
  | { kind: 'keystrokes'; commands: string[]; sessionId: string };
```

現有 `scheduleKeystrokes()` 保留。新增的 content scheduling 路徑負責等待 TUI readiness，再呼叫 `TerminalSubmit.submitContent()`。

同一 task 永遠只有一條有序 submission 序列：

1. Initial content 先排入。
2. Fresh spawn 若另有 `auto_command`，其 keystroke job 排在 initial content 後方。
3. `submitContent()` 確認提交完成後，scheduler 才執行下一個 job。

這維持目前「先提交 Task，再送 fresh-spawn auto-command」的順序，避免兩段文字合併成同一則訊息或 auto-command 超前。

## TUI Readiness

OpenCode adapter 的 `detectFirstOutput()` 只以 `ESC[?1049h` alternate-screen takeover 判斷 TUI 已接管 terminal。Windows shell 在 command dispatch 前也可能輸出 cursor-hide `ESC[?25l`，interactive shell 也可能啟用 generic bracketed-paste mode `ESC[?2004h`；這兩者都不足以表示 OpenCode ready。Initial content 只能在確認 alternate-screen takeover 的 `first-output` 後送出。

- Session 已是 `running`：監聽 `first-output`。
- Session 尚在 queue：先等待 `session-changed` 進入 `running`，再開始 readiness timeout。
- Listener 建立前若 `FirstOutputTracker` 已記錄該 session：立即視為 ready。
- Event 與 cache 必須共用一次性狀態，確保 prompt 只提交一次。

Queue 等待時間不計入 readiness timeout。Session 進入 `running` 後，以 120 秒作為 TUI readiness timeout。

## Fresh 與 Resume 行為

### Fresh

```text
spawn OpenCode without --prompt
  -> wait for OpenCode first-output
  -> submit complete Task XML with bracketed paste
  -> Task XML becomes the first user message
  -> run any queued fresh-spawn auto-command afterward
```

### Resume，有本次 Prompt

```text
spawn OpenCode with --session <id>
  -> wait for resumed TUI first-output
  -> submit only the current resumePrompt
```

### Resume，無本次 Prompt

```text
spawn OpenCode with --session <id>
  -> do not submit additional content
```

原始 Task XML 不會在 resume 時重送。

## 失敗與安全行為

Initial content delivery 不得使用「尚未 ready 仍強制送出」的 fallback。若文字落在 shell prompt，Task 內容可能被解讀為 shell command，違反 Issue #2 的安全驗收條件。

- Session exit、spawn cancellation、task 重新排程或 application shutdown：取消該 task 的 pending/active submissions。
- TUI readiness timeout：取消 submission，記錄錯誤，不向 PTY 寫入 prompt。
- `submitContent()` 失敗：記錄錯誤，不退回 `--prompt` 或 shell write。
- Session 保持既有生命週期；失敗不新增自動 respawn 或 retry subsystem。
- Logs 只包含 task/session metadata 與失敗階段，不得包含 prompt 本文。

`TerminalSubmit.submitContent()` 使用 OpenCode 的 paste verifier（目前為 `null`）與既有 activity/output evidence fallback 判斷提交完成。這個 fallback 發生在 Enter 之後，只確認 TUI 是否接受訊息，不等同於 readiness 前的 unsafe delivery fallback。

## 測試設計

### Adapter 與 Transition Unit Tests

- OpenCode 宣告 `initialPromptDelivery = 'terminal-submit'`。
- Fresh OpenCode command 即使存在 intent prompt 也不包含 `--prompt` 或 Task 內容。
- Resume command 包含 `--session <id>`，不包含待傳 prompt。
- Fresh intent 將完整 Task XML 排入 content job。
- Resume 只將本次 `resumePrompt` 排入 content job。
- Resume 沒有 prompt 時不排入 content job。
- Session record 的 `prompt` 仍保存本次 intended prompt。
- 其他 adapters 仍把 prompt 放入現有 command argument。

OpenCode 不再參與「所有 adapters 都以 `quoteArg(..., { multiline: true })` 保留 prompt」的共用測試，因為它已不經 command argument 傳輸。

### Scheduler Unit Tests

- Running session 等待 `first-output` 後只提交一次。
- Queued session 在等待期間不消耗 readiness timeout；進入 `running` 後才開始計時。
- 已存在 first-output cache 時立即提交，且後續 event 不重複提交。
- Session exit、cancel 與 timeout 均不提交內容。
- Initial content 完成前，後續 auto-command 不執行。
- `submitContent()` 收到的文字與輸入一致，涵蓋：
  - LF 多行英文。
  - CRLF 多行繁體中文。
  - 雙引號、單引號、backtick。
  - `& | < > ^ %`。
- Error logs 不含 prompt 本文。

### Windows `.cmd` E2E Regression

沿用現有 mock OpenCode 與 Windows `mockAgentPath('opencode')` 的 `.cmd` shim 路徑，讓 mock TUI：

1. 啟動後輸出 OpenCode 的 `first-output` marker。
2. 擷取 bracketed paste 所形成的第一則訊息。
3. 輸出可供 test assertion 使用的安全 marker 或寫入 test-owned capture file。

Fresh case 驗證完整 Task XML 成為單一第一則訊息。Resume case 驗證 command 使用既有 session ID，並只收到本次 `resumePrompt`。兩者都驗證啟動 command 不含 Task 本文，且測試用 shell side-effect sentinel 未被建立。

## 文件同步

實作時同步修正：

- Agent integration：OpenCode initial prompt 改為 TUI-ready terminal submission，不再描述為 `--prompt`。
- Transition engine：記錄 terminal-delivered initial prompt 與 fresh auto-command 的順序。
- Command injection：區分 initial free-form content job 與 keystroke burst，並記錄 readiness 前禁止 fallback 的安全界線。
- Architecture：更新 OpenCode fresh/resume 的 prompt delivery 資料流。

## 驗收對照

- 多行英文與繁體中文：由 bracketed paste 保留完整內容及行界線。
- LF 與 CRLF：各自建立 unit/E2E case，確認形成單一完整訊息。
- 引號與 Windows shell metacharacters：不再經 shell parsing，且以 sentinel 驗證未執行。
- Task 內容不當成 shell command：command 本身不包含 prompt，readiness 前也禁止 fallback write。
- Windows `opencode.cmd` 回歸測試：由實際 `.cmd` fixture 路徑覆蓋。
- 既有 session：先以 `--session` 恢復，再送本次 prompt；不重送 Task XML。

## 已排除方案

### 解析 `.cmd` 後直接啟動底層 Executable

此方式仍以 CLI argument 傳 prompt，但必須理解 npm、Scoop、Chocolatey 等不同安裝方式的 shim 與底層 runtime，形成版本脆弱的 adapter 行為。

### OpenCode Session API

JSON payload 可以可靠承載文字，但需要新增 server、session、TUI attach 與 shutdown 管理，明顯超出單一 Windows prompt bug 的最小修正。
