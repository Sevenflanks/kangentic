# 本機 Windows Installer

此文件說明 `Sevenflanks/kangentic` 的唯一封裝契約。此 fork 不建立 GitHub Release、draft workflow、npm publication、public artifact 或 auto-update feed。維護者只在自己的 Windows 電腦建置並使用 installer。

## 建置

從個人整合主線 `sevenflanks-main` 取得來源：

```bash
git clone https://github.com/Sevenflanks/kangentic.git
cd kangentic
git checkout sevenflanks-main
npm ci
```

來源執行使用：

```bash
npm run dev
```

建立 installer 使用：

```bash
npm run make:win
```

這是唯一支援的 fork 封裝命令。`make:win` 依序執行 `npm run rebuild`、production `npm run build`，最後執行 `electron-builder --win --publish never`。因此環境變數、tag 或 token 不會改變為發布行為。

## 產物與更新行為

成功建置會產生：

```text
out/Kangentic-Setup-X.Y.Z.exe
```

installer 為未簽署 EXE。Windows 可能顯示 SmartScreen 警告，僅在確認本機來源與版本後才執行。`electron-builder.yml` 的 `publish: null` 不設定 publish provider，封裝的 `out/win-unpacked/resources/` 也不得有 `app-update.yml`。既有 updater guard 會因此停用 auto-update，不影響本機啟動。

封裝資源必須包含下列檔案，且內容要與根目錄完全一致：

- `resources/LICENSE`
- `resources/FORK-NOTICE.md`

這些 legal resources 保留授權與 fork 通知，但不代表可將 EXE 交付給其他人。相關 conveying 要求見 [Fork AGPL Compliance Guide](fork-agpl-compliance.md)。

## 本機 QA

每次建立 installer 後，依 [Local Windows Installer QA](release-checklist.md) 確認產物路徑、未簽署狀態、缺少 `app-update.yml`、legal hash 與安全啟動。QA 不會建立 tag、上傳檔案、發布 npm package 或建立 release。

## Protocol Workspace

`@kangentic/protocol` 是 private workspace，不發布到 npm。需要驗證時只執行本機命令：

```bash
npm run build --workspace packages/protocol
npm pack --dry-run --workspace packages/protocol
```

這些命令建置或檢視 pack 清單，不會發布 package。

## Upstream Launcher

`npx kangentic` 是 upstream 的 distribution path，不會下載、安裝或執行此 fork。此 fork 的使用方式只有從來源執行，或由維護者自行建立本機 Windows installer。
