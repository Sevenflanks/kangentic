# 安裝

## 此 fork 的使用方式

`Sevenflanks/kangentic` 只支援兩種使用方式：從來源執行，以及由維護者在自己的 Windows 電腦建立本機 installer。`sevenflanks-main` 是 fork 的個人整合主線，也是預設工作基底。

```bash
git clone https://github.com/Sevenflanks/kangentic.git
cd kangentic
git checkout sevenflanks-main
npm ci
npm run dev
```

## 建立本機 Windows Installer

在 Windows 上執行：

```bash
npm run make:win
```

這是唯一的 fork 封裝入口。script 內建 electron-builder 的 `--publish never`，輸出為 `out/Kangentic-Setup-X.Y.Z.exe`。installer 未簽署、僅供本機使用，包含 `LICENSE` 與 `FORK-NOTICE.md`，而且沒有 auto-update feed。

1. 在自己的電腦上執行 `npm run make:win`。
2. 執行本機產生的 `out/Kangentic-Setup-X.Y.Z.exe`。
3. installer 未簽署，Windows 可能顯示 SmartScreen 警告。只在已確認本機來源與版本後，依系統提示繼續。
4. 更新時從已驗證來源重新建置並執行新的本機 installer。

## 先決條件

- Node.js 22+
- Git 2.25+
- C++ 建置工具，供 `better-sqlite3` 與 `node-pty` 等原生模組使用
- 至少一個已安裝並登入的支援 agent CLI

原生模組建置工具依平台而異：

- Windows：安裝 Visual Studio Build Tools 與 Python 3。
- macOS：執行 `xcode-select --install` 安裝 Xcode Command Line Tools。
- Linux：安裝發行版提供的 C/C++ 建置套件，例如 Debian 或 Ubuntu 的 `build-essential`。

## 上游發行版：`npx kangentic`

`npx kangentic` 是 upstream 發行管道。它會下載 `Kangentic/kangentic` 的 release，不會下載或安裝此 fork。需要 upstream 發行版時，請依 upstream 的文件使用該命令；需要此 fork 時，請使用前述來源執行或本機 Windows installer 方式。

## 疑難排解

### Agent CLI 找不到

確認選用的 agent CLI 已在 `PATH`，並依該 agent 的官方說明完成登入。例如：

```bash
claude --version
```

### 原生模組建置失敗

- 確認已安裝對應平台的 C++ 建置工具。
- Windows 也需要 Python 3 供 `node-gyp` 使用。
- 重新執行 `npm ci`，讓 lockfile 指定的相依套件重新安裝。

## 移除

### Windows

1. 開啟 **Settings > Apps > Installed apps**。
2. 找到 Kangentic 並選擇 **Uninstall**。
3. 如需刪除資料，再移除 `%APPDATA%\kangentic\`。

## 自訂資料目錄

設定 `KANGENTIC_DATA_DIR` 可讓來源建置與已安裝版本使用不同資料目錄。

```bash
KANGENTIC_DATA_DIR=/path/to/data npm run dev
```
