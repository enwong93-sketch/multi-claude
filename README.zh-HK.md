# Multi Claude（繁體中文／廣東話說明）

喺 Windows 同時開多個 Claude 桌面 App（每個一個帳戶），並且同步 **Claude Code 對話清單同上下文**，令你可以喺任何一個帳戶繼續同一個對話。

> 非官方工具，同 Anthropic 無關。依賴 App 未公開嘅檔案結構同程序名稱，更新版本後可能失效。請只用你有權使用嘅帳戶，並遵守 Anthropic 嘅條款同使用政策。

## 做咩

* 用獨立 `--user-data-dir` 開額外嘅 Runtime，每個有自己嘅登入、桌面捷徑同彩色圖示。
* `ccm login`：額外 Runtime 登入時，瀏覽器嘅 `claude://` 連結預設會開去主 App，呢個指令會將連結轉去等緊登入嗰個 Runtime。
* 對話清單喺所有 Runtime 之間雙向鏡像（最新嗰份贏、唔刪除）。
* 重點：只鏡像清單只會令 UI 更新，每個 Runtime 嘅對話引擎程序（`claude.exe --resume=<id>`）仲係舊記憶。所以當對話喺另一邊真正有新進度，同步會結束呢邊嗰個舊程序，下一次傾講嗰陣 App 自動重開並由完整逐字稿讀返。對面如果最近 3 分鐘有動靜就唔郁佢，同一對話 10 分鐘內最多處理一次。

## 快速開始

```powershell
git clone https://github.com/enwong93-sketch/multi-claude
cd multi-claude
$env:CCM_HOME = 'D:\ClaudeRuntimes'   # 選用：避免佔用 C 碟
node bin/ccm.mjs init
node bin/ccm.mjs add B
node bin/ccm.mjs login B              # 喺開出嚟嘅視窗用第二個帳戶登入
node bin/ccm.mjs add C
```

每個 Runtime 第一次登入後：開一次 **Code** 分頁，然後**關閉再開返**該 Runtime 一次，側欄先會列出同步嘅對話。之後用桌面捷徑開。工作列釘選要自己右鍵做。

## 注意

* 一個對話同一時間只喺一個 Runtime 用。
* 切換帳戶後會見到「Claude can't use thinking from another organization」，上下文冇丟失，只係第一次回覆會慢啲、多用啲額度。
* 唔支援 Cowork 對話；側欄分組可能同主 App 唔同（暫存資料夾會按名顯示）。
* 完整說明、風險同限制請睇英文 [README](README.md)。
