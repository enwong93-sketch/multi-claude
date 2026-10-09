#!/usr/bin/env node
import * as c from '../src/commands.mjs';

const HELP = `ccm - several Claude desktop runtimes with synced Claude Code sessions (Windows)

  ccm init [--primary-name A] [--primary-data <folder>]   create the config (home: %CCM_HOME% or ~/ClaudeRuntimes)
  ccm add <name> [--profile <folder>] [--no-shortcuts]    add a runtime (own profile folder, launcher, desktop shortcut)
  ccm login <name> [--minutes 10]                         open the runtime and forward the browser sign-in link to it
  ccm launch <name>                                       sync once, start the sync watcher, start the runtime
  ccm sync [--once|--watch]                               one sync pass (default) or the background watcher
  ccm shortcuts [name]                                    (re)create desktop shortcuts and icons
  ccm list | status | doctor
  ccm remove <name>                                       forget a runtime (never deletes its data)
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
try { table[cmd](args); } catch (e) { console.error(`ccm: ${e.message}`); process.exit(1); }
