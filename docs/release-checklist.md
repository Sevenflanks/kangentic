# Local Windows Installer QA

本清單驗證維護者在自己的 Windows 電腦建立的本機 installer。它不是 release checklist，不會建立 tag、GitHub Release、draft、npm publication、public artifact 或 auto-update feed。

## 建置前確認

- 來源位於預定使用的 commit，且 `git status --short` 已人工確認。
- `package.json` 的 `make:win` 為 `npm run rebuild && npm run build && electron-builder --win --publish never`。
- `electron-builder.yml` 的 top-level `publish` 為 `null`。
- 根目錄有 `LICENSE` 與 `FORK-NOTICE.md`。

## 建立產物

在 Windows 上執行：

```powershell
npm run make:win
```

確認只產生一個符合版本的 installer：

```powershell
$installers = @(Get-ChildItem out\Kangentic-Setup-*.exe)
if ($installers.Count -ne 1) { throw "Expected exactly one Windows installer." }
$installers.FullName
```

顯示的唯一路徑就是本次 installer。installer 必須是未簽署產物：

```powershell
Get-AuthenticodeSignature -LiteralPath $installers[0].FullName | Select-Object Status
```

預期 `Status` 是 `NotSigned`。

## 更新與 legal resources

確認未產生更新 manifest：

```powershell
Test-Path out\win-unpacked\resources\app-update.yml
```

預期 `False`。沒有 `app-update.yml` 時，既有 updater guard 會停用 auto-update，且不應阻止 app 啟動。

確認 packaged legal resources 存在，並與根目錄計算相同 SHA-256：

```powershell
Get-FileHash LICENSE -Algorithm SHA256
Get-FileHash out\win-unpacked\resources\LICENSE -Algorithm SHA256
Get-FileHash FORK-NOTICE.md -Algorithm SHA256
Get-FileHash out\win-unpacked\resources\FORK-NOTICE.md -Algorithm SHA256
```

每一對 hash 必須相同。

## 安全啟動

用隔離的暫存 user-data directory 啟動 unpacked app，確認 process 已啟動後關閉該 process，最後移除暫存目錄。不要使用正式使用者資料，也不要關閉任何其他 Electron process。

```powershell
$temporaryUserData = Join-Path $env:TEMP "kangentic-installer-qa-$PID"
$userDataArgument = "--user-data-dir=`"$temporaryUserData`""
$appProcess = Start-Process -FilePath "out\win-unpacked\Kangentic.exe" -ArgumentList $userDataArgument -PassThru
Start-Sleep -Seconds 5
Get-Process -Id $appProcess.Id
Stop-Process -Id $appProcess.Id
Wait-Process -Id $appProcess.Id
Remove-Item -LiteralPath $temporaryUserData -Recurse -Force
```

啟動成功表示缺少 `app-update.yml` 不會妨礙本機使用。若啟動失敗，保留診斷資訊，先修正問題再重新建置。

## 不得發布確認

- 不執行 `npm publish`、不帶 `--dry-run` 的 `npm pack`，或任何 GitHub release、tag、draft、upload 指令。
- 不建立或觸發 publication workflow。
- 不把 EXE 提供給其他人。若未來需要 conveying，必須先依 [Fork AGPL Compliance Guide](fork-agpl-compliance.md) 核准 exact source、notices、provenance 與 identity 設計。
- `npx kangentic` 是 upstream-only launcher，不是此 fork 的測試、安裝或更新方式。
