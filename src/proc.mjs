// Process helpers (Windows). All PowerShell calls are hidden and short-lived.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ps = (script, timeout = 20000) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout, windowsHide: true });

export function listClaudeProcesses() {
  const out = ps(`@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`).trim();
  if (!out) return [];
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j : [j]).filter(p => p && p.CommandLine).map(p => ({ pid: p.ProcessId, cmd: p.CommandLine }));
}

const norm = p => resolve(p).toLowerCase().replace(/[\\/]+$/, '');

/**
 * Which runtime owns a process? The one whose userData folder appears in the command line (the CLI engine lives under
 * <userData>\\claude-code\\ and the app itself is started with --user-data-dir). The longest match wins; the primary app
 * started without the flag is recognised by its default userData path in the engine path, or by lacking the flag.
 */
export function runtimeOf(cmd, runtimes) {
  const c = cmd.toLowerCase().replace(/\//g, '\\');
  let best = null;
  for (const r of runtimes) {
    const u = norm(r.userData);
    if (c.includes(u) && (!best || u.length > norm(best.userData).length)) best = r;
  }
  if (best) return best;
  if (!/--user-data-dir/i.test(cmd)) return runtimes.find(r => r.primary) || null;
  return null;
}

export function isMainProcess(cmd) { return !/--type=|stream-json/.test(cmd); }

export function endResumeProcesses(runtimeName, cliSessionId, runtimes, list = listClaudeProcesses()) {
  if (!/^[0-9a-f-]{36}$/i.test(cliSessionId || '')) return [];
  const killed = [];
  for (const p of list) {
    if (!/stream-json/.test(p.cmd) || !p.cmd.includes(`resume=${cliSessionId}`)) continue;
    if (runtimeOf(p.cmd, runtimes)?.name !== runtimeName) continue;
    try { process.kill(p.pid); killed.push(p.pid); } catch { /* already gone */ }
  }
  return killed;
}

export function extraRuntimeRunning(runtimes, list = listClaudeProcesses()) {
  return list.some(p => isMainProcess(p.cmd) && runtimeOf(p.cmd, runtimes) && !runtimeOf(p.cmd, runtimes).primary);
}
