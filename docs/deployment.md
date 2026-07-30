# 本機 Windows Installer

此文件說明 `Sevenflanks/kangentic` 的唯一封裝契約。此 fork 只支援從來源執行，以及由維護者在自己的 Windows 電腦建立並使用 unsigned installer。

此 repository 不提供 GitHub Release、npm publication、public artifact、hosted distribution 或 auto-update feed。`make:mac` 與 `make:linux` 僅因 upstream development tooling 保留，並非此 fork 支援或核准的 distribution path。

## 從來源執行

從個人整合主線取得來源：

```bash
git clone https://github.com/Sevenflanks/kangentic.git
cd kangentic
npm ci
npm run dev
```

## 建立本機 Windows Installer

在 Windows 上執行：

```bash
npm run make:win
```

這是唯一支援的 fork 封裝命令。`make:win` 依序執行 rebuild、production build，最後執行 `electron-builder --win --publish never`。任何環境變數、tag 或 token 都不會改變為發布行為。

成功建置會產生：

```text
out/Kangentic-Setup-X.Y.Z.exe
```

installer 為未簽署 EXE。Windows 可能顯示 SmartScreen 警告，僅在確認本機來源與版本後才執行。`electron-builder.yml` 的 `publish: null` 不設定 publish provider，封裝的 `out/win-unpacked/resources/` 也不得有 `app-update.yml`。既有 updater guard 會因此停用 auto-update，不影響本機啟動。

封裝資源必須包含下列檔案，且內容要與根目錄完全一致：

- `resources/LICENSE`
- `resources/FORK-NOTICE.md`

這些 legal resources 保留授權與 fork 通知。任何對外 conveying 都必須遵循 [Fork AGPL Compliance Guide](fork-agpl-compliance.md)，但本 fork 不提供公開下載或交付流程。

## 本機 QA

每次建立 installer 後，依 [Local Windows Installer QA](release-checklist.md) 確認產物路徑、未簽署狀態、缺少 `app-update.yml`、legal hash 與安全啟動。QA 不建立 tag、不上傳檔案、不發布 npm package，也不建立 release。

## Protocol Workspace

`@kangentic/protocol` 是 private workspace，不發布至 npm。需要驗證時只執行本機命令：

```bash
npm run build --workspace packages/protocol
npm pack --dry-run --workspace packages/protocol
```

這些命令只建置或檢視 pack 清單，不會發布 package。

## Launcher 邊界

`npx kangentic` 是 upstream 的 distribution path，不會下載、安裝或執行此 fork。本 fork 的使用方式只有從來源執行，或由維護者自行建立本機 Windows installer。
