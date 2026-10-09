import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig, saveConfig, addRuntime, allRuntimes, homeDir, configPath, validateName } from './config.mjs';
import { listClaudeProcesses, runtimeOf, isMainProcess, endResumeProcesses, extraRuntimeRunning } from './proc.mjs';
import { createSync, runWatch, discoverSides, fileLogger } from './sync.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'multi-claude.mjs');
const psFile = (script, args) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', windowsHide: true });

export function findClaudeExe() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation`], { encoding: 'utf8', windowsHide: true }).trim();
  const exe = out && join(out, 'app', 'Claude.exe');
  if (!exe || !existsSync(exe)) throw new Error('The Claude desktop app (Microsoft Store / MSIX package "Claude") was not found.');
  return exe;
}

const need = cfg => { if (!existsSync(configPath(cfg.home))) throw new Error(`No configuration yet. Run: multi-claude init`); };
const logOf = cfg => fileLogger(join(cfg.home, 'sync.log'));
const runtimeByName = (cfg, name) => {
  const rt = allRuntimes(cfg).find(r => r.name.toLowerCase() === String(name).toLowerCase());
  if (!rt) throw new Error(`Unknown runtime "${name}". Known: ${allRuntimes(cfg).map(r => r.name).join(', ')}`);
  return rt;
};

export function cmdInit(args) {
  const home = homeDir(); const cfg = loadConfig(home);
  if (args['primary-name']) { validateName(args['primary-name']); cfg.primary.name = args['primary-name']; }
  if (args['primary-data']) cfg.primary.userData = resolve(args['primary-data']);
  saveConfig(cfg);
  console.log(`Home: ${home}\nConfig: ${configPath(home)}\nPrimary runtime "${cfg.primary.name}" -> ${cfg.primary.userData}\nNext: multi-claude add <name>`);
}

export function writeLauncher(cfg, rt) {
  const dir = join(cfg.home, rt.name); mkdirSync(dir, { recursive: true });
  const vbs = join(dir, 'launch.vbs');
  const q = s => `"""${s}"""`;
  writeFileSync(vbs, `Option Explicit\r\nCreateObject("WScript.Shell").Run ${q(process.execPath)} & " " & ${q(ENTRY)} & " launch ${rt.name}", 0, False\r\n`);
  return vbs;
}

export function cmdShortcuts(args) {
  const cfg = loadConfig(); need(cfg);
  const desktop = join(process.env.USERPROFILE || homedir(), 'Desktop');
  const targets = args._[0] ? [runtimeByName(cfg, args._[0])] : allRuntimes(cfg);
  const palette = ['#d97757', ...cfg.runtimes.map(r => r.color || '#555555')];
  for (const rt of targets) {
    const idx = allRuntimes(cfg).indexOf(allRuntimes(cfg).find(r => r.name === rt.name));
    const vbs = writeLauncher(cfg, rt);
    const out = psFile('make-shortcut.ps1', ['-Letter', rt.name, '-Color', rt.color || palette[idx] || '#555555', '-Title', `Claude ${rt.name}`,
      '-Vbs', vbs, '-IconPath', join(cfg.home, rt.name, 'icon.ico'), '-OutDirs', `${desktop},${join(cfg.home, 'Launchers')}`]);
    console.log(out.trim());
  }
  console.log('Pin them to the taskbar yourself (right-click > Pin to taskbar); Windows does not allow scripting that.');
}

export function cmdAdd(args) {
  const name = args._[0]; if (!name) throw new Error('Usage: multi-claude add <name> [--profile <folder>] [--no-shortcuts]');
  const cfg = loadConfig(); need(cfg);
  const rt = addRuntime(cfg, name, args.profile);
  mkdirSync(rt.profile, { recursive: true });
  saveConfig(cfg);
  console.log(`Added runtime "${rt.name}" with profile ${rt.profile}`);
  if (!args['no-shortcuts']) cmdShortcuts({ _: [rt.name] });
  console.log(`Next: multi-claude login ${rt.name}   (opens the runtime and helps the sign-in link reach it)`);
}

export function cmdRemove(args) {
  const name = args._[0]; const cfg = loadConfig(); need(cfg);
  const rt = runtimeByName(cfg, name);
  if (rt.primary) throw new Error('The primary runtime cannot be removed.');
  cfg.runtimes = cfg.runtimes.filter(r => r.name !== rt.name); saveConfig(cfg);
  console.log(`Removed "${rt.name}" from the configuration. Its profile folder ${rt.profile} and any shortcuts were left untouched.`);
}

export function cmdList() {
  const cfg = loadConfig(); need(cfg);
  for (const r of allRuntimes(cfg)) console.log(`${r.primary ? '*' : ' '} ${r.name.padEnd(12)} ${r.userData}`);
}

function startApp(rt) {
  const exe = findClaudeExe();
  const argv = rt.primary ? [] : [`--user-data-dir=${rt.userData}`];
  spawn(exe, argv, { detached: true, stdio: 'ignore' }).unref();
}

const pidFile = cfg => join(cfg.home, 'sync.pid');
function watcherAlive(cfg) {
  try { const pid = Number(readFileSync(pidFile(cfg), 'utf8')); process.kill(pid, 0); return pid; } catch { return 0; }
}
export function ensureWatcher(cfg) {
  if (watcherAlive(cfg)) return false;
  spawn(process.execPath, [ENTRY, 'sync', '--watch'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  return true;
}

export function cmdLaunch(args) {
  const cfg = loadConfig(); need(cfg);
  const rt = runtimeByName(cfg, args._[0]);
  const runtimes = allRuntimes(cfg);
  try { createSync({ cfg, log: logOf(cfg) }).syncOnce(); } catch { /* sync is best effort */ }
  ensureWatcher(cfg);
  const running = listClaudeProcesses().some(p => isMainProcess(p.cmd) && runtimeOf(p.cmd, runtimes)?.name === rt.name);
  if (running) { console.log(`${rt.name} is already running.`); return; }
  startApp(rt);
  console.log(`Started ${rt.name}.`);
}

export function cmdLogin(args) {
  const cfg = loadConfig(); need(cfg);
  const rt = runtimeByName(cfg, args._[0]);
  if (rt.primary) throw new Error('The primary runtime signs in the normal way.');
  const minutes = Number(args.minutes || 10);
  const exe = findClaudeExe();
  const log = join(cfg.home, rt.name, 'capture.log');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(ROOT, 'scripts', 'capture-forward.ps1'),
    '-Profile', rt.userData, '-Exe', exe, '-Log', log, '-Minutes', String(minutes)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  cmdLaunch({ _: [rt.name] });
  console.log(`Sign in inside the "${rt.name}" window now. The helper runs for ${minutes} minutes and forwards the sign-in link from the browser to it.`);
  console.log(`After the first sign-in: open the Code tab once, then close and reopen "${rt.name}" so it picks up the mirrored session list.`);
}

export function cmdSync(args) {
  const cfg = loadConfig(); need(cfg);
  const runtimes = allRuntimes(cfg); const log = logOf(cfg);
  const recycle = (name, id) => endResumeProcesses(name, id, runtimes);
  if (args.watch) {
    if (watcherAlive(cfg)) { console.log('A sync watcher is already running.'); return; }
    writeFileSync(pidFile(cfg), String(process.pid));
    process.on('exit', () => { try { unlinkSync(pidFile(cfg)); } catch { /* ignore */ } });
    runWatch({ cfg, log, recycle, shouldExit: () => !extraRuntimeRunning(runtimes) });
    return;
  }
  const n = createSync({ cfg, log, recycle }).syncOnce();
  console.log(`synced ${n} file(s)`);
}

export function cmdStatus() {
  const cfg = loadConfig(); need(cfg);
  const runtimes = allRuntimes(cfg); const procs = listClaudeProcesses();
  for (const r of runtimes) {
    const mine = procs.filter(p => runtimeOf(p.cmd, runtimes)?.name === r.name);
    const main = mine.some(p => isMainProcess(p.cmd)); const convs = mine.filter(p => /stream-json/.test(p.cmd)).length;
    const sides = discoverSides(cfg).filter(s => s.runtime === r.name);
    const files = sides.reduce((n, s) => n + readdirSync(s.dir).filter(f => /^local_.*\.json$/.test(f)).length, 0);
    console.log(`${r.name.padEnd(12)} app:${main ? 'running' : 'stopped'}  conversation processes:${convs}  session dirs:${sides.length}  session files:${files}`);
  }
  console.log(`sync watcher: ${watcherAlive(cfg) ? 'running (pid ' + watcherAlive(cfg) + ')' : 'not running'}`);
}

export function cmdDoctor() {
  const ok = (c, m) => console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`);
  ok(process.platform === 'win32', `platform ${process.platform} (Windows required)`);
  ok(Number(process.versions.node.split('.')[0]) >= 20, `node ${process.versions.node}`);
  let exe = null; try { exe = findClaudeExe(); } catch { /* reported below */ }
  ok(!!exe, `Claude desktop installed${exe ? ': ' + exe : ''}`);
  const cfg = loadConfig(); ok(existsSync(configPath(cfg.home)), `config ${configPath(cfg.home)}`);
  for (const r of allRuntimes(cfg)) {
    ok(existsSync(r.userData), `${r.name}: userData ${r.userData}`);
    ok(discoverSides(cfg).some(s => s.runtime === r.name), `${r.name}: has a claude-code-sessions\\<account>\\<org> folder (appears after the first Code use)`);
  }
}
