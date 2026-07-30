# Kangentic launcher

## Fork 安裝政策

本 fork 不發布 `kangentic` npm package，`npx kangentic` 不是本 fork 的安裝指令。

此目錄中的 launcher implementation 刻意維持不變。它設定 `REPO_OWNER = Kangentic`，並從官方 upstream [Kangentic/kangentic GitHub Releases](https://github.com/Kangentic/kangentic/releases) 下載 installer，不會從 `Sevenflanks/kangentic` 下載 release。

若要從 source 建置本 fork，請依照 [fork installation guide](https://github.com/Sevenflanks/kangentic/blob/sevenflanks-main/docs/installation.md)。本 fork 未獲 upstream project 背書，也不隸屬於 upstream project。本 README 不表示 upstream 對本 fork 或其 source build 有任何背書。

## Upstream launcher 行為

以下指令只說明未變更 launcher 的行為，適用於刻意選擇 upstream npm package 與官方 upstream release 的使用者。

```bash
npx kangentic
```

launcher 會下載目前平台對應的 upstream installer、安裝後啟動 app。首次執行後，已安裝的 upstream app 會在 Windows 與 macOS 管理自己的更新。

### Open a specific project

```bash
npx kangentic /path/to/your/project
```

## Upstream launcher 的運作方式

1. 偵測平台與架構。
2. 從 [Kangentic/kangentic GitHub Releases](https://github.com/Kangentic/kangentic/releases) 下載對應 installer。
3. 依平台安裝：
   - **Windows：** 靜默執行 NSIS installer，目標是 `%LOCALAPPDATA%\Programs\Kangentic\`。
   - **macOS：** 將 ZIP 解壓縮到 `~/Applications/Kangentic.app`。
   - **Linux：** 在 RPM 系統且未偵測到 `apt` 時使用 `sudo rpm -i` 安裝 `.rpm` package，其他情況使用 `sudo dpkg -i` 安裝 `.deb` package。
4. 啟動已安裝的 upstream app。
1. Detects your platform (Windows, macOS, Linux) and architecture (x64, arm64)
2. Downloads the matching installer from [GitHub Releases](https://github.com/Kangentic/kangentic/releases)
3. Installs per platform:
   - **Windows:** Runs NSIS installer silently to `%LOCALAPPDATA%\Programs\Kangentic\`
   - **macOS:** Extracts .zip to `~/Applications/Kangentic.app`
   - **Linux:** Installs .rpm on RPM-family systems (`sudo dnf install` on Fedora/RHEL,
     `sudo zypper install` on openSUSE, falling back to `sudo rpm -i`) or .deb elsewhere
     (`sudo apt install`, falling back to `sudo dpkg -i`); prompts for password
4. Launches the app

## Upstream 更新

完成初次 upstream 安裝後，通常不需要再次執行 `npx kangentic`：

- **Windows：** `electron-updater` 會在重啟時靜默安裝新版本。
- **macOS：** 內建 updater 會在背景下載並提示重啟，且需要 code signing。
- **Linux：** 沒有 auto-update。重新執行 `npx kangentic`，或從 [Kangentic/kangentic GitHub Releases](https://github.com/Kangentic/kangentic/releases) 下載。

### 安裝指定 upstream 版本

```bash
npx kangentic@0.2.0
```

launcher version 與 upstream app version 相符。指定版本會下載該 upstream release。

## Upstream launcher 前置條件

- 已安裝 **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)**，且可從 `PATH` 找到。
- **[Git 2.25+](https://git-scm.com/)**，供 worktree support 使用。

## Fork 連結

- [Fork repository](https://github.com/Sevenflanks/kangentic)
- [Fork documentation](https://github.com/Sevenflanks/kangentic/tree/sevenflanks-main/docs)
- [Fork installation guide](https://github.com/Sevenflanks/kangentic/blob/sevenflanks-main/docs/installation.md)

## License

[AGPL-3.0-only](https://github.com/Sevenflanks/kangentic/blob/sevenflanks-main/LICENSE)
