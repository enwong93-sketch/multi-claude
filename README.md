# Multi Claude

Run **several Claude desktop apps side by side on Windows, one account each**, and keep their **Claude Code session lists and conversation context in sync**, so you can continue the same conversation from whichever account you are signed in to.

> Unofficial. Not affiliated with or endorsed by Anthropic. It relies on undocumented behaviour of the desktop app (file layout, process names) that can change in any release. Use it only with accounts you are entitled to use, and respect Anthropic's terms and usage policies. Read [What it touches](#what-it-touches) before you use it.

[繁體中文說明 / Cantonese notes](README.zh-HK.md)

## What it does

| Problem | What this tool does |
|---|---|
| The Store app only runs one profile | Starts extra copies with their own `--user-data-dir`, each with its own login. Adds a desktop shortcut per runtime with the Claude icon plus a coloured letter badge (read from the installed app at run time; nothing is bundled). |
| The extra runtime cannot sign in (the `claude://` link always opens the primary app) | `multi-claude login` forwards the sign-in link from the browser to the runtime that is waiting for it. |
| Each runtime only lists its own Code conversations | Mirrors the session index files between all runtimes (newest copy wins, no deletes). |
| After switching runtime, the model "forgets" the work done in the other one | Ends the stale per-conversation engine process in the other runtimes, so the next message re-reads the shared transcript. |

## Requirements

* Windows 10/11, Claude desktop installed from the Microsoft Store (package `Claude`)
* Node.js 20 or newer (no npm dependencies)

## Quick start

```powershell
git clone https://github.com/enwong93-sketch/multi-claude
cd multi-claude
# optional: keep everything off the system drive
$env:MULTI_CLAUDE_HOME = 'D:\MultiClaude'      # default: %USERPROFILE%\MultiClaude

node bin/multi-claude.mjs init                    # the normal app becomes the primary runtime "A"
node bin/multi-claude.mjs add B                   # profile, launcher and desktop shortcut for runtime B
node bin/multi-claude.mjs login B                 # opens B; sign in with the second account
node bin/multi-claude.mjs add C                   # as many as you like
```

After the first sign-in of a runtime:

1. Open the **Code** tab once, so the app creates its session folder.
2. **Close and reopen** that runtime once. An app only watches its session folder if the folder existed when it started; after that the mirrored conversations appear in its sidebar.

From then on start runtimes from their shortcuts (or `multi-claude launch B`). Launching a runtime runs one sync pass and starts a small background watcher that exits by itself when no extra runtime is open. Pin the shortcuts to the taskbar yourself; Windows does not allow scripting that.

## Commands

```
multi-claude init [--primary-name A] [--primary-data <folder>]
multi-claude add <name> [--profile <folder>] [--no-shortcuts]
multi-claude login <name> [--minutes 10]
multi-claude launch <name>
multi-claude sync [--once|--watch]
multi-claude shortcuts [name]
multi-claude list | status | doctor
multi-claude remove <name>        # forgets the runtime; never deletes its data
```

Configuration is one file, `<home>\multi-claude.json`: runtime names, profile folders and the timing knobs `busyWindowMs`, `recycleCooldownMs`, `syncIntervalMs`, `recycle`. Set `"recycle": false` to mirror the session lists only and never end any process.

## How context is kept in sync

Claude Code conversations are stored as transcripts in `~\.claude\projects\...`, shared by every runtime, plus one small index file per conversation in each runtime's own `claude-code-sessions\<account>\<org>\local_*.json`. Mirroring the index files makes a conversation *visible* everywhere. It does not refresh the model's memory: each runtime keeps the conversation in an in-memory engine process (`claude.exe --resume=<id>`), so the other runtime's engine still holds the old state.

The sync therefore also ends that stale engine process when a conversation was really worked on elsewhere (its `lastActivityAt` is newer; focus or title changes do not count). The app respawns the engine on the next message and reads the full transcript. Safeguards:

* a runtime whose index file changed in the last `busyWindowMs` (3 min) is considered busy; the recycle is deferred, and dropped if that runtime did newer work meanwhile;
* at most one recycle per conversation and runtime every `recycleCooldownMs` (10 min);
* you are expected to use **one runtime per conversation at a time**. Running the same conversation in two runtimes simultaneously is not supported.

Expect a notice such as "Claude can't use thinking from another organization" after switching accounts, and a slightly slower, costlier first reply: the earlier reasoning blocks of the other account cannot be reused and are regenerated. Context itself is not lost.

## What it touches

* Creates the home folder, one profile folder per extra runtime, launcher scripts, icons and shortcuts. `multi-claude remove` leaves them in place.
* Reads and writes `claude-code-sessions\<account>\<org>\local_*.json` in every runtime. It never deletes, never touches transcripts, and skips `scheduled-tasks.json`.
* Ends `claude.exe` processes that match `stream-json` and `resume=<id>` and belong to a runtime other than the one you just used. It never ends app windows.
* `multi-claude login` starts a hidden PowerShell loop for a limited time. It reads the one-time `claude://` sign-in link from the command line of the process Windows starts for it and passes it to your own extra runtime on the same machine. The link is never printed or stored; only its host/path and length are logged. If you do not want this, sign in with a method that does not use the browser redirect or skip `multi-claude login`.
* Nothing is sent over the network by this tool.

## Known limits

* One account per runtime. If you switch accounts inside a runtime, remove stale `claude-code-sessions\<account>` folders or they will be mirrored too.
* Conversations are mirrored as listed by the app; Cowork sessions are not synced.
* Sidebar grouping can differ between runtimes: conversations started in a scratch folder of another runtime may show up under a folder named after that scratch folder instead of "No folder", because the app decides this relative to its own data folder. Rewriting working directories is deliberately not done, as it could break transcript lookup.
* Verified on Windows 11 with Claude desktop 2.x (Store build) and Claude Code engine 2.1.x. Behaviour of newer builds is not guaranteed; run `multi-claude doctor` after an update.

## Development

```powershell
npm test      # node --test, no dependencies
```

The sync core (`src/sync.mjs`) and process attribution (`src/proc.mjs`) are covered by unit tests that run against temporary folders; nothing in the tests starts Claude or ends a real process.

## License

MIT
