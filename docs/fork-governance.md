# Fork 治理契約

本文件定義此 fork 的雙主線治理方式。目標是讓個人開發可持續整合，同時保留一條能精確對齊 upstream 的乾淨主線。

## 主線角色

| Branch | 角色 | 規則 |
| --- | --- | --- |
| `main` | upstream 鏡像 | 鎖定為 upstream 的精確鏡像，不接受個人功能、修補或合併。只有經確認的 upstream 同步可以更新此 branch。 |
| `sevenflanks-main` | 個人整合主線 | 承接個人功能、修補與日常整合，是所有個人開發的預設起點與回流目標。 |

`fork-from` remote 已設定，fetch 與 push 均指向 `https://github.com/Kangentic/kangentic.git`；此設定只描述已存在的 remote，調整 tracking 或執行 upstream 同步仍須另行確認。

## Branch 流程

### 個人開發

1. 個人 branch 一律從 `sevenflanks-main` 建立。
2. 完成並通過驗證後，一律回到 `sevenflanks-main` 整合。
3. 不可把個人開發直接提交或合併至 `main`。

### Upstream contribution

1. 準備回饋 upstream 的 branch 時，必須從乾淨的 `main` 建立。
2. 「乾淨」表示基底只含 upstream 歷史，不含 `sevenflanks-main` 的個人整合提交。
3. contribution branch 只放該次貢獻必要的變更，不回流個人功能或 fork 專用治理內容。

## 貢獻與 CLA

此 fork 只接受並維護以 `AGPL-3.0-only` 授權的 contributions。此 fork 不主張擁有 VORPAHL LLC 的授權權限，不代 upstream 收集簽署，也不提供商業授權或雙重授權。

準備 upstream contribution 時，branch 必須依上述流程維持乾淨。實際提交 upstream 時，貢獻者必須遵循 upstream 當時自己的 contribution 與 CLA 流程。基於此責任邊界，upstream CLA 文件與 CLA bot workflow 在此 fork 中刻意維持不存在。

## Kangentic 預設基底

`kangentic.json` 的 top-level `defaultBaseBranch` 設為 `sevenflanks-main`，讓 Kangentic 建立一般 task worktree 時預設使用個人整合主線。

此設定只決定 worktree 的預設來源 branch。它不建立或修改 Git remote、upstream、branch tracking、branch protection，也不改變 `main` 與 `sevenflanks-main` 的 Git 關係。

## Release 與品牌

在品牌決策完成前，禁止以 upstream 的名稱、品牌或發行身分公開發布此 fork。這個阻擋包含公開 release 與其他會使使用者誤認為 upstream 官方產物的發布方式。品牌決策完成後，必須先更新本治理契約，才能解除阻擋。

目前唯一核准的 distribution mode 是由維護者在自己的 Windows 電腦上建立並使用 unsigned installer。此 repository 不提供 GitHub Release、npm publication、public artifact 或 auto-update feed。

`make:mac`、`make:linux` 以及對應的 electron-builder targets 因 upstream development tooling 而保留，但僅供 fork 內部開發使用。它們不是此 fork 支援、驗證或核准的 distribution path，也不代表任何 signing、notarization 或 publication 承諾。

## Repository 指令範圍

`.claude` 目錄刻意維持不存在。本次治理不新增或搬移任何 `.claude` 規則，也不以 repository-local agent 設定取代本文件。

此 repository-local 限制不會移除產品對外部使用者專案中 `.claude` content 的支援。外部專案既有的 commands、skills、agents 與 settings 仍是受支援的產品功能。

## 授權不變量

此 fork、其修改、治理文件與後續衍生版本全部維持 `AGPL-3.0-only`。不得在 fork 治理、品牌調整、公開發布或其他後續工作中改用不同授權或加入替代授權。

## 機器可驗證契約

以下資料是本文件的結構化摘要，供 unit test 驗證治理不變量。若文字規則調整，必須同步更新此契約，且不得弱化上述限制。

```json
{
  "schemaVersion": 1,
  "license": "AGPL-3.0-only",
  "branches": {
    "upstreamMirror": {
      "name": "main",
      "locked": true,
      "remoteConfigured": true
    },
    "personalIntegration": {
      "name": "sevenflanks-main",
      "personalBranchesStartFrom": "sevenflanks-main",
      "personalBranchesReturnTo": "sevenflanks-main"
    },
    "upstreamContribution": {
      "startsFrom": "main",
      "requiresCleanBase": true
    }
  },
  "boardConfig": {
    "defaultBaseBranch": "sevenflanks-main",
    "gitTrackingEffect": "none"
  },
  "release": {
    "upstreamIdentity": "blocked",
    "blocker": "branding-decision",
    "distributionMode": "local-only",
    "windowsPackaging": "local-unsigned-only",
    "macosPackaging": "retained-upstream-development-only-unapproved",
    "linuxPackaging": "retained-upstream-development-only-unapproved",
    "publicArtifacts": "disabled",
    "npmPublication": "disabled",
    "autoUpdateFeed": "disabled"
  },
  "repository": {
    "claudeDirectory": "intentionally-absent",
    "externalProjectClaudeContent": "supported"
  },
  "contributions": {
    "license": "AGPL-3.0-only",
    "upstreamClaAutomation": "disabled",
    "upstreamClaDocument": "absent"
  }
}
```
