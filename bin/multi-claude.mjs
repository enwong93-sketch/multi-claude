#!/usr/bin/env node
import * as c from '../src/commands.mjs';

const HELP = `multi-claude - several Claude desktop runtimes with synced Claude Code sessions (Windows)

  multi-claude init [--primary-name A] [--primary-data <folder>]   create the config (home: %MULTI_CLAUDE_HOME% or ~/MultiClaude)
  multi-claude add <name> [--profile <folder>] [--no-shortcuts]    add a runtime (own profile folder, launcher, desktop shortcut)
  multi-claude login <name> [--minutes 10]                         open the runtime and forward the browser sign-in link to it
  multi-claude launch <name>                                       sync once, start the sync watcher, start the runtime
  multi-claude sync [--once|--watch]                               one sync pass (default) or the background watcher
  multi-claude shortcuts [name]                                    (re)create desktop shortcuts and icons
  multi-claude list | status | doctor
  multi-claude remove <name>                                       forget a runtime (never deletes its data)
`;

function parse(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; } } else a._.push(t);
  }
  return a;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parse(rest);
const table = { init: c.cmdInit, add: c.cmdAdd, remove: c.cmdRemove, list: c.cmdList, launch: c.cmdLaunch, login: c.cmdLogin, sync: c.cmdSync, shortcuts: c.cmdShortcuts, status: c.cmdStatus, doctor: c.cmdDoctor };
if (!cmd || !table[cmd]) { console.log(HELP); process.exit(cmd ? 1 : 0); }
try { table[cmd](args); } catch (e) { console.error(`multi-claude: ${e.message}`); process.exit(1); }
