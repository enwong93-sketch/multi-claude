// N-way mirror of Claude Code "session index" files (claude-code-sessions\<account>\<org>\local_*.json) between runtimes.
// - real files only (Claude refuses symlinks/junctions in its private folders)
// - newest mtime wins; the copy gets the same mtime, so nothing ping-pongs
// - never deletes (archive a conversation instead); account specific files (scheduled-tasks.json) are not synced
// - after a real update in runtime X, the stale `claude.exe --resume=<id>` process of the same conversation in every other
//   runtime is ended (deferred while that runtime looks busy). The app starts a fresh one on the next message and it re-reads
//   the shared transcript, so context follows you across accounts.
import { readdirSync, statSync, copyFileSync, utimesSync, renameSync, existsSync, readFileSync, watch, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { allRuntimes } from './config.mjs';

const FILE = /^local_[0-9a-f-]+\.json$/i;
const dirsIn = d => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(d, e.name)); } catch { return []; } };
const filesIn = d => { try { return readdirSync(d).filter(f => FILE.test(f)); } catch { return []; } };
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Every <userData>\claude-code-sessions\<account>\<org> folder that exists. Use one account per runtime. */
export function discoverSides(cfg) {
  const out = [];
  for (const rt of allRuntimes(cfg)) for (const acct of dirsIn(join(rt.userData, 'claude-code-sessions'))) for (const org of dirsIn(acct)) out.push({ runtime: rt.name, dir: org });
  return out;
}

function copyAtomic(src, dst, mtime) {
  const tmp = dst + '.sync-tmp';
  copyFileSync(src, tmp); renameSync(tmp, dst); utimesSync(dst, mtime, mtime);
}

export function createSync({ cfg, log = () => {}, recycle = () => [], now = Date.now }) {
  const pending = new Map();      // `${runtime}|${cliId}` -> deferred recycle
  const lastRecycle = new Map();

  const doRecycle = (runtime, id, key) => {
    lastRecycle.set(key, now());
    try { const pids = recycle(runtime, id); if (pids.length) log(`recycled stale ${runtime} process pid ${pids.join(',')} for ${id}`); } catch (e) { log(`recycle ERR ${id}: ${e.message}`); }
  };

  function copyAndMaybeRecycle(src, dst, mtime, destRuntime) {
    const s = readJson(src), d = readJson(dst);
    const destAge = now() - statSync(dst).mtimeMs;   // before the copy: when did the destination runtime last touch its own file?
    copyAtomic(src, dst, mtime);
    const id = s?.cliSessionId;
    if (!cfg.recycle || !id || !d) return;
    if (!(Number(s.lastActivityAt) > Number(d.lastActivityAt) + 1000)) return;   // source did not do real work (focus/title only)
    const key = `${destRuntime}|${id}`;
    if (destAge < cfg.busyWindowMs) { pending.set(key, { dst, runtime: destRuntime, id, srcLast: Number(s.lastActivityAt) }); log(`defer recycle ${id}: ${destRuntime} active ${Math.round(destAge / 1000)}s ago`); return; }
    if (now() - (lastRecycle.get(key) ?? 0) < cfg.recycleCooldownMs) { log(`skip recycle ${id}: cooldown on ${destRuntime}`); return; }
    doRecycle(destRuntime, id, key);
  }

  function retryPending() {
    for (const [key, { dst, runtime, id, srcLast }] of pending) {
      let age; try { age = now() - statSync(dst).mtimeMs; } catch { pending.delete(key); continue; }
      if (age < cfg.busyWindowMs) continue;
      pending.delete(key);
      if (Number(readJson(dst)?.lastActivityAt) > srcLast + 1000) continue;   // that runtime did newer work meanwhile: its memory is the fresh one
      if (now() - (lastRecycle.get(key) ?? 0) < cfg.recycleCooldownMs) continue;
      doRecycle(runtime, id, key);
    }
  }

  function syncOnce() {
    retryPending();
    const sides = discoverSides(cfg); let n = 0;
    for (const f of new Set(sides.flatMap(s => filesIn(s.dir)))) {
      try {
        const have = sides.map(s => { const p = join(s.dir, f); return existsSync(p) ? { s, p, st: statSync(p) } : { s, p, st: null }; });
        const src = have.filter(h => h.st).reduce((a, b) => (b.st.mtimeMs > a.st.mtimeMs ? b : a));
        for (const h of have) {
          if (h === src) continue;
          if (!h.st) { copyAtomic(src.p, h.p, src.st.mtime); log(`${src.s.runtime}->${h.s.runtime} new ${f}`); n++; continue; }
          if (Math.abs(src.st.mtimeMs - h.st.mtimeMs) < 1500 && src.st.size === h.st.size) continue;
          copyAndMaybeRecycle(src.p, h.p, src.st.mtime, h.s.runtime); log(`${src.s.runtime}->${h.s.runtime} update ${f}`); n++;
        }
      } catch (e) { log(`ERR ${f}: ${e.message}`); }
    }
    return n;
  }
  return { syncOnce, pending };
}

/** Long-running watcher. `shouldExit()` is polled every interval; three misses in a row end the process. */
export function runWatch({ cfg, log, recycle, shouldExit }) {
  const { syncOnce } = createSync({ cfg, log, recycle });
  log(`watch started; sides: ${discoverSides(cfg).map(s => s.runtime).join(',')}; initial pass changed ${syncOnce()} file(s)`);
  let t = null; const kick = () => { clearTimeout(t); t = setTimeout(() => { const n = syncOnce(); if (n) log(`pass: ${n} change(s)`); }, 900); };
  const watched = new Set();
  const attach = () => { for (const { dir } of discoverSides(cfg)) if (!watched.has(dir)) { try { watch(dir, kick); watched.add(dir); log(`watching ${dir}`); } catch (e) { log(`watch ${dir} failed: ${e.message}`); } } };
  attach();
  setInterval(() => { attach(); const n = syncOnce(); if (n) log(`interval pass: ${n} change(s)`); }, cfg.syncIntervalMs);
  let misses = 0;
  setInterval(() => { if (!shouldExit()) misses = 0; else if (++misses >= 3) { syncOnce(); log('no extra runtime running; final pass done, exiting'); process.exit(0); } }, cfg.syncIntervalMs);
}

export function fileLogger(file) {
  mkdirSync(join(file, '..'), { recursive: true });
  return m => { try { appendFileSync(file, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
}
