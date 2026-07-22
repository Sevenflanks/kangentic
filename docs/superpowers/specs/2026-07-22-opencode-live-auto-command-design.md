# OpenCode 活躍 Session 的目的泳道 Auto-command 設計

**範圍：Issue #3 子專案 1**

## 背景與範圍

[Issue #3](https://github.com/Sevenflanks/kangentic/issues/3) 是一個 umbrella issue，已拆分為三個彼此界線清楚的子專案。本文件只定義子專案 1：在保留既有、活躍中的 OpenCode Main/create-or-resume session 前提下，安全地交付目的泳道的 `auto_command`。子專案 2 是偵測與設定一致性；子專案 3 是啟動就緒、watchdog 與 Retry/Reconnect 等復原控制。它們不在本設計的實作範圍內。

產品優先序明確：session 與使用者輸入高於自動化。自動化可以失敗，但不得殺死 TUI、覆寫使用者正在輸入的內容，或暗中重啟另一個 session。

目前問題的已證實根因如下。對於同一 agent、Main/create-or-resume 軌跡且仍活躍的 session，`task:move` 會由 `prepareInjectionPlan` 產生 live injection，再呼叫 `TerminalSubmitScheduler.scheduleKeystrokes`。現有 live path 會設定 `sendCtrlC=true`；OpenCode adapter 把 Ctrl+C 定義為離開序列，因此共用的 generic interrupt 語意會終止 OpenCode TUI。Issue #2 已完成的 initial-content terminal-submit 只處理新建或恢復時的初始內容交付，與本 live-injection 路徑分離，不能修正此問題。

## 目標與非目標

### 目標

- 在符合設定條件的活躍 OpenCode session 中，等待正常 native `session.idle` 邊界後交付目的泳道自己的 lane-level `auto_command`。
- 在等待中讓使用者輸入取消自動化；在短暫送出期間獨占輸入，避免位元組交錯。
- 不重啟、不重生、不以 Ctrl+C 清場，並以 session 身分與設定 generation 防止過時工作送入錯誤目標。
- 對 UI、IPC 與日誌提供無命令本文的狀態與取消原因。

### 明確非目標

- 不建立 OpenCode server、API client 或其 lifecycle。
- 不加入持久佇列、DB schema、app restart 後重播或至少一次投遞承諾。
- 不擴張 task-level MCP `autoCommand` 的既有行為；本設計只處理目的泳道自己的 lane-level `auto_command` 在既存活躍 session 的 live delivery。
- 不改變 To Do/Done 的既有角色優先序，也不改變 spawn、suspend、handoff、model 或 effort 的既有語意。
- 不實作 Retry、Reconnect、startup readiness、watchdog 或偵測設定同步；這些屬於 Issue #3 子專案 2 與 3。
- 不以 OpenCode 是否實際執行 slash command 作為成功判定，因為本系統沒有 command verifier。

## 領域規則與適用性

本功能是設定驅動，不是泳道名稱驅動。`Executing -> Code Review` 僅是理解流程的例子，絕不可成為條件。對任意目的泳道，只有其有效屬性同時符合以下條件時，才適用本功能：

1. 目的泳道 `auto_spawn=true`。
2. 目的泳道自己的 lane-level `auto_command` 為非空字串。
3. 任務仍在相同且活躍的 session track。
4. `resolveForceFresh=false`。
5. 解析後 agent 與目前 session 的 agent 相同。
6. 不存在 model 或 effort 所要求的 restart 條件。
7. 解析後 adapter 宣告可使用本文件定義的 live submission policy。

泳道名稱、排序、顏色、icon 與固定 ID 永遠不得參與路由或判斷。To Do/Done 的 role priority 仍先於以上規則，故不會因 `auto_command` 改寫既有清理、suspend、archive 行為。所有 task mutation 繼續在 `withTaskLock` 下執行；所有 agent spawn 仍只能通過既有 `spawnAgent` 或 `prepareAgentSpawn` chokepoint 與共同的 `runSpawnPreamble`。

## 考量方案與採用決策

### 方案 A：adapter capability 加上既有 scheduler

將「何時可安全交付」作為 adapter capability，由既有 `TerminalSubmitScheduler` 使用；activity 子系統只提供狹窄的 readiness evidence。優點是沿用 task-keyed cancel、generation、session guard、burst coalescing 與 terminal submission lifecycle；缺點是 scheduler 必須增加受限的 waiting state，而不能把所有 agent 的差異塞進共用分支。

### 方案 B：獨立 `TurnBoundaryCommandQueue`

建立新的 queue，訂閱活動事件並於 turn boundary 投遞命令。它的概念隔離明確，但會重複 scheduler 的取消、session 身分、生命週期與輸入所有權，容易出現兩個 pending owner、兩條交付路徑和不一致的 timeout。這不是本範圍所需的新增子系統。

### 方案 C：OpenCode server/API

透過 OpenCode server 或 API 發送指令，理論上可避免 PTY 位元組問題，但引入新的外部 lifecycle、連線、認證、版本相容性與復原責任，也超出已證實的問題範圍。

### 採用：受限混合方案

採用方案 A 的 adapter capability 與既有 scheduler，但加入 activity 提供的「正常 native idle」證據和明確輸入所有權協調。這是受限混合，不是僅追求最小 diff：adapter 擁有 agent 語意，activity 擁有事件真實性，scheduler 擁有所有 pending state 與 lifecycle，`TerminalSubmit` 保持純位元組交付。此分界避免 agent 名稱散落在共用層，同時不複製佇列或引入 OpenCode server。

## 架構與元件責任

### `LiveSubmissionPolicy`

adapter contract 新增 discriminated `LiveSubmissionPolicy`。預設維持既有行為，代表目前的 live keystroke submission；OpenCode 明確 opt-in：

```ts
type LiveSubmissionPolicy =
  | {
      mode: 'interrupt-immediately';
      sendCtrlC: true;
    }
  | {
      mode: 'wait-for-native-idle';
      timeoutMs: 120_000;
      cancelOnUserInput: true;
      sendCtrlC: false;
    };
```

共享層只依 policy 的 `mode` 行事，不能以 agent 名稱分支。OpenCode adapter 宣告 `wait-for-native-idle`；其他 adapter 未 opt-in 時使用 `interrupt-immediately`，保留既有預設行為。此 policy 是 adapter 宣告的語意，不是 UI 或 task-move 對 OpenCode 名稱的特例。

### Activity 子系統

activity 子系統暴露狹窄、只讀的 clean-native-idle readiness evidence，而非暴露整個 engine 實作。它必須能提供指定 session 是否有「正常 native `session.idle`」事件，以及該事件後是否出現使用者輸入。若 scheduler 訂閱事件，採 listener-first、snapshot-second：先註冊 listener，再讀取快照並重新檢查 generation，避免快照與訂閱之間漏掉剛到達的 idle。

`ActivityState='idle'` 與現有 `idleAuthoritative` 都不足以授權本提交。PTY/watchdog fallback、`interrupted`、turn failure 與 OpenCode `session.error` 都可能讓 activity 變成 idle 或使 `idleAuthoritative` 為真，卻不代表 OpenCode 正在一個正常的 native `session.idle` 輸入邊界。只有 OpenCode 正常 native `session.idle` 才是授權事件。

clean cached idle 的定義是：最後一個可用的正常 native idle 發生後，直到交付前沒有任何使用者輸入證據。使用者輸入證據來自 terminal input 寫入途徑，且須帶 session identity；它不是 PTY output，也不是 agent 產生的事件。

### `TerminalSubmitScheduler`

`TerminalSubmitScheduler` 是本功能唯一的 pending-state 與 lifecycle owner。它負責：建立 task-keyed request、timeout、activity listener、使用者輸入 listener、session/config generation guard、latest generation wins、取消、短暫 sending ownership、狀態通知與 cleanup。若既有 scheduler 過大，可抽出私有、無狀態的 readiness helper；helper 不得擁有 timer、listener、queue、持久化或交付狀態。

### `TerminalSubmit`

`TerminalSubmit` 只負責依 scheduler 指令完成位元組交付。它不判斷 lane、agent、idle、timeout、使用者輸入或 retry。對本 policy 的交付永遠使用 `sendCtrlC=false`，完成後必須釋放 terminal interactivity ownership。

## 資料流與狀態機

### 請求建立與資料守衛

1. `task:move` 在既有 `withTaskLock` 與 transition priority 下解析目的泳道有效設定、session track、agent、`resolveForceFresh`、model/effort restart 狀態與 adapter policy。
2. 若不符合本設計的所有設定條件，維持既有 transition 行為，不建立 waiting request。
3. 若 policy 為 `wait-for-native-idle`，scheduler 建立只存在記憶體中的 request，捕捉 `taskId`、`sessionId`、session generation、configuration generation 與不記錄於日誌的命令本文。這裡的 configuration generation 是該 request 對目的泳道有效設定所持有的記憶體版本／fingerprint，不新增 DB 欄位。
4. 同一 task 的新 request 會提升 generation 並取消舊 request；只有最新 generation 可繼續。快速連續搬動時，latest generation wins。

### Clean-idle 立即交付

建立 request 時，scheduler 先註冊 native-idle 與 user-input listener，再讀 clean-idle snapshot。若同一 `sessionId`、相同 session generation 與相同 configuration generation 已持有 clean cached idle，request 不等待下一個 idle，直接進入 `sending`。送出前再次驗證所有 guard；任何不符即取消而非交付。

### Busy 等待與 native-idle 釋放

若 session 仍忙碌或 cached idle 不乾淨，request 狀態為 `waiting`，最長 120 秒。只有同一 session 的正常 native `session.idle` 事件，且事件後尚無使用者輸入，才能釋放等待。PTY/watchdog idle、interrupted、turn failure、`session.error` 或任意非 native idle 都不釋放等待。

### 使用者輸入與送出所有權

在 `waiting` 期間，任何同一 session 的使用者輸入證據立刻取消 request，原因為 `user-input`，不寫入自動命令。在轉入 `sending` 前，scheduler 取得短暫 submission ownership，阻止新使用者輸入與自動位元組交錯；現有已經開始的使用者輸入不會被搶走，因為它會先取消 waiting request。ownership 僅涵蓋一次交付呼叫，無論成功或失敗均在 `finally` 中恢復 terminal interactivity。

### Session、設定與生命週期事件

- session exit、suspend、identity 改變或 track 不再相同時，取消為 `session-exit`。
- OpenCode `session.error` 或其他 turn error 在等待期間取消為 `turn-error`。
- 120 秒屆滿取消為 `timeout`，session 繼續存活且不重啟。
- 同一 task 的後續有效 configuration 或 lane 變更取消舊 generation 為 `superseded`；新 generation 依當下有效設定重新評估。
- app shutdown 取消為 `shutdown`，不持久化且不在下次啟動重播。
- byte delivery 拋錯取消為 `delivery-error`；不可 retry Enter、不可送 Ctrl+C、不可 respawn。

`delivered` 僅表示完整命令位元組與提交位元組已成功寫入 PTY。它不表示 OpenCode 已解析、接受或執行 slash command；系統不存在可用的 OpenCode command verifier，也不得顯示假成功。

## 可見狀態、錯誤處理與隱私

Main process 以專用、project-scoped push event 發布 delivery status，不借用 spawn progress。Payload 必須包含 `projectId`、`taskId`、`sessionId`、request generation 與以下 status；這個 event 不建立 DB 記錄，也不提供 app restart 後的查詢或重播：

```ts
type LiveDeliveryStatus =
  | { state: 'waiting' }
  | { state: 'sending' }
  | { state: 'delivered' }
  | { state: 'cancelled'; reason: 'user-input' | 'timeout' | 'session-exit' | 'turn-error' | 'delivery-error' | 'superseded' | 'shutdown' };
```

UI 在 `waiting` 顯示此任務正等待 agent 的正常可輸入邊界；`sending` 顯示短暫送出中；`delivered` 可作為卡片或 terminal 的非干擾性瞬態完成狀態。成功不產生 noisy toast。

取消警告只針對 `user-input`、`timeout`、`session-exit`、`turn-error`、`delivery-error`，且以人可理解的原因說明未交付。`superseded` 與 `shutdown` 靜默。IPC 與日誌只可帶 task/session ID、policy mode、狀態、原因、generation 與時間，不得帶 `auto_command` 本文或可推回其內容的 payload。

交付前的可逆邊界是「尚未寫入第一個位元組」。第一個位元組一旦寫入，系統無法可靠得知完整命令或 Enter 是否已被 TUI 接收，亦不能安全重試。因此本設計不提供 exactly-once 保證；只承諾在所有 guard 通過時嘗試一次 byte delivery，並誠實回報已知交付結果。

## 不可違反的安全不變量

1. 不隱式 restart、respawn 或建立第二個 OpenCode process。
2. 沒有安全 native-idle 證據時不得 fallback 成 generic interrupt 或立即送出。
3. 本自動化路徑永遠不送 Ctrl+C。
4. 最新有效設定勝出，舊 generation 不可送出。
5. session identity 與 session/config generation 必須在建立、idle release 與送出前均一致。
6. 使用者輸入在 waiting 時永遠勝過自動化。
7. sending 時輸入不可與 automation byte interleave，且送出後必須恢復 interactivity。
8. `delivered` 不得被表述為 OpenCode 已執行命令。
9. request 只存在記憶體，app restart 後不保存、不重播。
10. 日誌、IPC、toast 與 telemetry 不得洩漏命令本文。

## 測試設計

### Unit

- 驗證 `LiveSubmissionPolicy`：預設 `interrupt-immediately` 不改變既有 adapter 行為；OpenCode 的 `wait-for-native-idle` 固定為 120 秒、cancel-on-user-input、`sendCtrlC=false`。
- 驗證 readiness helper：僅正常 native `session.idle` 形成 clean idle；PTY/watchdog fallback、interrupted、turn failure、`session.error` 不可授權。
- 驗證 listener-first/snapshot-second：訂閱與快照交錯時不漏掉 idle，且 stale generation 不可釋放 request。
- 驗證 scheduler：clean-idle 立即交付、busy 等待、native idle 釋放、120 秒 timeout、user-input cancellation、session-exit、turn-error、delivery-error、shutdown、rapid moves 的 latest generation wins、session identity/config generation guard、短暫 sending ownership 與 finally restoration。
- 驗證任何本 policy 的送出都呼叫 `TerminalSubmit` 並帶 `sendCtrlC=false`，且不重試 Enter 或產生 spawn。

### Configuration-driven task-move

- 以任意名稱與 ID 的泳道建立案例，包括名稱為 `Finalize` 的目的泳道，驗證只有有效 `auto_spawn`、非空 `auto_command`、同 session track、`resolveForceFresh=false`、same agent 與無 restart 的組合會排入本 policy。
- 對名稱、順序、顏色、icon、固定 ID 改動後，驗證結果不變。
- 驗證 To Do/Done role priority 維持原結果，並驗證 model/effort restart、agent 改變、force fresh、不同 track 與空命令不會使用 live waiting delivery。
- 驗證 task-level MCP `autoCommand` 行為未被本功能改寫。

### Activity、UI 與 E2E

- activity evidence tests 覆蓋 native idle、使用者輸入使 cached idle 失效、turn error、session error 與 watchdog fallback。
- UI tests 驗證 `waiting`、`sending`、非干擾性 `delivered` 與各可見 cancellation warning；`superseded`、`shutdown` 無 toast；任何顯示、IPC mock 和 diagnostic payload 都沒有命令本文。
- Windows `.cmd` E2E 重用既有 mock OpenCode fixture，讓同一 process/session 經過 busy -> native idle -> receipt。驗證沒有 Ctrl+C、沒有第二 process、命令只在 native idle 後送達，且 happy path 不重複 receipt，並且送出後 terminal 仍可互動；這不是 delivery failure 下的 exactly-once 保證。
- Windows 11 手動 QA 使用真實 OpenCode：在同一 Main/create-or-resume session 中移至符合條件的任意目的泳道，確認 TUI 未退出、未重新開 process、無 Ctrl+C、命令只在正常 native idle 後送達且 happy path 不重複 receipt、使用者在等待時輸入會保留並取消 automation、送出後仍能立即正常輸入；不據此宣稱 failure path 具 exactly-once 保證。

## 驗收標準

- [ ] 對符合所有設定條件的活躍同 agent OpenCode session，目的泳道 `auto_command` 僅在正常 native `session.idle` 後以 `sendCtrlC=false` 嘗試一次交付。
- [ ] 移動範圍不依賴任何 literal lane name、排序、色彩、icon 或固定 ID；名稱為 `Finalize` 的任意泳道與其他任意名稱具有相同設定時行為一致。
- [ ] To Do/Done role priority、task-level MCP `autoCommand`、spawn chokepoint 與 `withTaskLock` 邊界維持既有行為。
- [ ] session 忙碌時 UI 顯示 waiting；正常 native idle 才釋放；PTY/watchdog fallback、interrupted、turn failure 與 `session.error` 不會釋放。
- [ ] 使用者在等待時輸入會取消 automation 且不覆寫其輸入；sending 期間不會交錯位元組，完成或失敗後 terminal 恢復互動。
- [ ] timeout、session-exit、turn-error、delivery-error 與 user-input 提供原因警告並保留 session；superseded 與 shutdown 靜默。
- [ ] `delivered` 僅代表完整 bytes 已寫入，UI 不宣稱 OpenCode 已執行命令。
- [ ] 交付錯誤後不重試 Enter、不送 Ctrl+C、不 restart 或 respawn；app restart 後沒有 persistence 或 replay。
- [ ] Windows `.cmd` E2E 與 Windows 11 真實 OpenCode QA 證明同一 process/session、無 Ctrl+C、無第二 process、native idle 後才 receipt、happy path 不重複 receipt，且 terminal 可持續互動；不把此結果描述為 exactly-once 保證。
- [ ] 新增實作不引入 dependency、DB schema、persistent queue、OpenCode server lifecycle 或 adapters 以外的 agent-name branching，且不記錄命令本文。

## 風險與假設

- 假設 OpenCode adapter 可穩定辨識正常 native `session.idle`；若該證據遺失，安全結果是 120 秒後取消，而不是猜測可送出。
- 假設 terminal input 管線可以對 session 產生可靠的使用者輸入證據，並可在送出期間短暫協調 ownership。這項整合必須不改變一般使用者輸入內容。
- PTY 寫入在第一個 byte 後沒有可逆、跨平台的 exactly-once acknowledgement。故 delivery error 的保守處置是停止，而非 retry。
- 本設計保留目前 activity engine 與 OpenCode 觀測機制；偵測涵蓋率、config consistency、啟動就緒與復原體驗由後續子專案處理，不能被本實作暗中補入。

## 延後子專案

### 子專案 2：偵測與設定一致性

定義 OpenCode 偵測能力、adapter capability 與使用者設定在 UI、持久設定和有效設定之間的一致性。它不在本文件中新增任何偵測分支或設定遷移。

### 子專案 3：啟動就緒、watchdog 與復原控制

定義 startup readiness、watchdog、失敗診斷與使用者可見的 Retry/Reconnect 控制。它不在本文件中新增 retry、reconnect、background recovery 或 restart 行為。
