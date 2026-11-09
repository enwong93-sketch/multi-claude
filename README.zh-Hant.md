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
