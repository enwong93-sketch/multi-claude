# Multi Claude（繁體中文說明）

在 Windows 上同時執行多個 Claude 桌面應用程式（每個使用一個帳戶），並同步 **Claude Code 的對話清單與上下文**，讓你可以在任何一個帳戶中繼續同一個對話。

> 非官方工具，與 Anthropic 無關。本工具依賴應用程式未公開的檔案結構與處理程序名稱，版本更新後可能失效。請僅使用你有權使用的帳戶，並遵守 Anthropic 的條款與使用政策。

[English README](README.md)

## 功能

* 以獨立的 `--user-data-dir` 啟動額外的 Runtime（執行個體），每個 Runtime 擁有各自的登入狀態、桌面捷徑與彩色圖示。
* `multi-claude login`：額外的 Runtime 登入時，瀏覽器的 `claude://` 連結預設會開啟主應用程式；此指令會把連結轉交給正在等待登入的 Runtime。
* 對話清單在所有 Runtime 之間雙向鏡像。**進度較新**的一份勝出（而非檔案時間較新者），避免舊記錄覆蓋新進度。
* 在某一個 Runtime 刪除對話，其他 Runtime 也會移除，但只是移入 `<home>\sync-trash`，不會真正銷毀；若一次有超過 3 個檔案同時消失，則不會傳播刪除。
* 覆寫檔案之前，會先把舊版本複製到 `<home>\sync-undo`，供當日內還原之用（見下方「磁碟用量」）。
* 只鏡像清單只會更新介面，各 Runtime 的對話引擎處理程序（`claude.exe --resume=<id>`）可能仍保留舊的記憶。你可以在設定檔中啟用 `"recycle": true`，同步程式便會結束該對話在其他 Runtime 中已過時的引擎處理程序；下次傳送訊息時，應用程式會自動重新啟動它，並從完整的逐字稿讀回內容。此功能**預設關閉**，因為第一版會無條件這樣做，曾在對話進行途中強制結束處理程序。

## 快速開始

```powershell
git clone https://github.com/enwong93-sketch/multi-claude
cd multi-claude
$env:MULTI_CLAUDE_HOME = 'D:\MultiClaude'   # 選用：避免佔用系統磁碟
node bin/multi-claude.mjs init
node bin/multi-claude.mjs add B
node bin/multi-claude.mjs login B              # 在開啟的視窗中以第二個帳戶登入
node bin/multi-claude.mjs add C
```

每個 Runtime 首次登入後：先開啟一次 **Code** 分頁，再將該 Runtime **關閉後重新開啟**一次，側邊欄才會列出已同步的對話。之後請從桌面捷徑啟動。釘選到工作列需自行以右鍵操作，Windows 不允許以指令碼代為完成。

## Antigravity（實驗性）

Antigravity 每個對話一個 SQLite 檔（protobuf 步驟記錄），存於 `~/.gemini/antigravity`（桌面應用）及 `~/.gemini/antigravity-cli`（agy 命令列），另有索引列及 `~/.gemini/config/projects` 下的專案小檔。對話按電腦區分，與帳戶無關。

`multi-claude agy-export [--since <天數>] [--dry-run]` 會將 Claude Code 對話（各執行環境 `~/.claude/projects/*/<id>.jsonl` 內的文字回合）轉成 Antigravity 對話，寫入桌面應用的儲存位置，成為與桌面原生對話相同格式、不屬任何專案的對話（不會建立空的專案資料夾）。轉換以原生對話為範本，只替換內容。已封存及 `/btw` 旁枝對話會略過；`--cli` 另可寫入 agy 命令列儲存（使用不同 ID）。匯出前請先關閉 Antigravity 桌面應用，它會在下次啟動時由檔案重建清單。需要 Node 22.5 或以上（`node:sqlite`）。

- 重複執行成本低：未變更的對話會略過。凡在 Antigravity 內繼續過（步驟數多於匯出時）的對話，絕不覆寫。
- 匯入保留最近一段使用者和助理文字，完整逐字稿繼續保存在 Claude。Claude 回退後，如父子記錄都含相同的回退訊息 ID，匯出會按該訊息接續歷史。
- `multi-claude add <名稱> --app antigravity` 可新增具獨立登入設定檔的 Antigravity 實例。批量匯入請手動執行 `agy-export`。
- 首次設定時，先在 Antigravity 完成一則簡短對話，再完全退出應用程式。執行 `multi-claude agy-export` 匯入及配對 Claude 對話，再執行 `multi-claude agy-live --watch` 並重新開啟 Antigravity。Claude Desktop 開啟期間，Antigravity 已完成的文字會接到各 Claude 設定檔共用的 JSONL。Claude 的新增文字會在 Antigravity 完全退出後追加，下次開啟時可讀取。

### 可選平台同步群組

可選任意兩個平台，亦可三個一起同步。例如先連接 Claude 與 Codex，再將 Antigravity 加入同一群組：

```powershell
multi-claude sync-group project --claude "<Claude CLI 工作階段 ID>" --codex "<Codex rollout JSONL 的絕對路徑>"
multi-claude sync-group project --antigravity "<Antigravity 對話 ID>"
multi-claude agy-live --groups --watch
```

請選擇已有已完成回合的對話。各平台以加入時的紀錄為起點，新完成的文字會同步到其他已選成員。Claude 開啟時會透過共用 JSONL 接收更新。寫入 Codex 或 Antigravity 前，會等該接收端完全退出。省略 `--watch` 只會執行一次。每個群組同一時間由一個平台新增回合。若兩個成員各自推進，程式會保留兩邊紀錄並回報衝突。舊配對沿用原有設定，可選其他對話建立群組。

## 磁碟用量

本工具寫入的任何內容都不會無限成長，所有上限均可在 `multi-claude.json` 中調整。預設值如下：

| 項目 | 位置 | 預設上限 |
|---|---|---|
| 覆寫前的檔案備份 | `<home>\sync-undo\<runtime>\` | 每個對話、每個 Runtime 只保留最新 **3** 份；不保留超過 **1 天**的備份；整個資料夾上限 **100 MB**（先刪除最舊者） |
| 在某 Runtime 刪除的對話 | `<home>\sync-trash\<日期>\<runtime>\` | 保留 **14 天**，整個資料夾上限 **50 MB** |
| 記錄檔 | `<home>\sync.log` | 達 **1 MB** 時輪替為 `sync.log.old`，合計最多約 2 MB |
| 同步狀態 | `<home>\sync-state.json` | 數 KB，原地覆寫 |

整理工作在同步過程中最多每 10 分鐘執行一次。單一對話記錄是很小的 JSON 檔（一般為 5 至 50 KB），但對話進行時會頻繁被改寫，並複製到每個 Runtime。在作者自己的環境（五個 Runtime）中，若不設上限，備份每日約增加 100 MB。備份僅用於當日內還原一次錯誤的同步，你可以隨時調低上限，或直接刪除 `sync-undo` 資料夾，不會影響其他功能。`multi-claude status` 會顯示備份與垃圾桶資料夾目前的大小。

相關設定：`undoKeepDays`、`undoKeepPerFile`、`undoMaxMB`、`trashKeepDays`、`trashMaxMB`、`logMaxBytes`、`pruneIntervalMs`。

## 注意事項

* 同一個對話在同一時間只應在一個 Runtime 中使用。
* Microsoft Store 更新 Claude 時，Windows 會強制關閉所有 Runtime，未儲存的工作將會遺失。請選擇空閒時間更新，或關閉 Store 的自動更新（需要管理員權限）。
* 額外 Runtime 登入時，`claude://` 連結在部分版本會被已開啟的主應用程式接收，導致 `multi-claude login` 無法截取。可暫時關閉主應用程式後再試，或使用登入畫面提供的其他登入方式。
* 切換帳戶後可能出現「Claude can't use thinking from another organization」的提示。上下文並未遺失，只是首次回覆會較慢、消耗較多額度。
* 不支援 Cowork 對話；側邊欄的分組可能與主應用程式不同（暫存資料夾會依名稱顯示）。
* 完整說明、風險與限制請參閱英文版 [README](README.md)。

## 授權

MIT
