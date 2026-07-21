# Fork AGPL Compliance Guide

本文件是此 fork 維護者的操作檢查表。它依 `AGPL-3.0-only` 的文字整理專案政策，不是法律意見，也不保證任何特定情境的法律結果。遇到不確定的發布、服務或第三方元件情境時，先取得合格法律意見。

## 基本事實

1. 原始專案來源為 https://github.com/Kangentic/kangentic。
2. fork 來源為 https://github.com/Sevenflanks/kangentic。
3. 此 fork 於 2026-07-20 修改。此日期只記錄 fork 的修改，不主張原始專案於該日開始。
4. 原始專案的著作權標示必須保留：`Copyright (C) 2025-2026 VORPAHL LLC`。
5. 不得以本文件或 `FORK-NOTICE.md` 主張 upstream 程式碼的所有權、upstream 背書、關聯或官方身分。
6. 此 fork 與其修改維持 `AGPL-3.0-only`。完整授權文字位於根目錄 `LICENSE`。

## 三種使用情境

### 私人本機建置與使用

私人在本機建置、執行與修改，且不將副本、二進位檔或套件交付給其他人時，不是本專案所稱的 conveying。現行契約只允許從來源執行，或以 `npm run make:win` 在自己的 Windows 電腦建立未簽署 EXE。此模式沒有 GitHub Release、npm publication、public artifact 或 auto-update feed。仍須保留 `LICENSE`、著作權標示與 `FORK-NOTICE.md`，並記錄實際建置的 commit，讓日後若要 conveying 時可以追溯來源。

### Conveying 二進位檔或套件

將安裝程式、壓縮檔、npm package、容器映像或其他副本提供給其他人下載、交付或散布，即使免費，也必須在 conveying 前另行核准 source、notice、provenance 與 identity 設計，並完成下列事項。

1. 建立公開且可取得的 exact tag 或 commit，並以該 exact tag 或 commit 建置 artifact。
2. 對每個 artifact 提供該 release 的 Exact Corresponding Source。來源必須與實際建置的 tag 或 commit 完全相同，不可只指向浮動 branch。
3. 確認 Corresponding Source 包含完成該 work 所需的 source、完整 `LICENSE`、`FORK-NOTICE.md`、所有適用 notices，以及建置與安裝所需的 scripts。
4. 在 release 資訊或 artifact 隨附資料中清楚記錄 tag 或 commit、建置時間與 artifact 名稱或 checksum，讓收件者能將 artifact 對應到來源。
5. 不得移除或改寫 `Copyright (C) 2025-2026 VORPAHL LLC`，也不得加入尚未核准的 fork 貢獻者著作權主張。

### 提供修改版網路服務

若修改版支援使用者透過電腦網路遠端互動，`AGPL-3.0-only` 第 13 節要求向每位遠端互動使用者顯著提供免費取得該版本 Corresponding Source 的機會。來源應由網路伺服器透過標準或慣常的軟體複製方式提供，並對應正在提供服務的實際版本。不要以私有 repository、無法存取的連結或與部署版本不同的 branch 取代該 source offer。

## Conveying 前檢查表

只要下列任一項未完成，向其他人 conveying 一律停止。

1. Source/tag: 沒有公開 exact tag 或 commit，或 artifact 不是由該 ref 建置。
2. `LICENSE`: artifact 或發布資料未附完整 `AGPL-3.0-only` 授權文字。
3. `FORK-NOTICE.md`: artifact 或發布資料未附本 fork 的修改、來源與對應來源通知。
4. Artifact provenance: 沒有可重現的建置記錄，無法將 artifact 對應至 exact tag 或 commit、建置腳本與必要 notices。
5. Branding identity: `docs/fork-governance.md` 尚未因完成品牌決策而更新。此狀態下公開 release 被封鎖，尤其不得使用會使使用者誤認為 upstream 官方產物的名稱、品牌或發布身分。

發布者應在 conveying 前逐項記錄已完成的證據。若同時提供網路服務，還要確認第 13 節所需的 source offer 已在遠端使用者互動處顯著提供。

## 發布身分閘門

目前不得對其他人 conveying 此 fork 的 EXE 或其他 artifact。此 repository 也沒有 GitHub Release、npm publication、public artifact 或 auto-update feed。未來若要提供 EXE，必須先個別核准 exact source、notices、artifact provenance 與公開身分設計，並更新 `docs/fork-governance.md`。即使 source、notice 與 artifact provenance 已齊備，未完成這些控制前仍不得散布。

## 維護範圍

本指南處理此 fork 的操作政策。它不改寫 `LICENSE`，不取代 `AGPL-3.0-only` 的完整條款，也不改變 upstream 專案的權利或發布決策。
