// N-way mirror of Claude Code "session index" files (claude-code-sessions\<account>\<org>\local_*.json) between runtimes.
// - real files only (Claude refuses symlinks/junctions in its private folders); scheduled-tasks.json is account specific and never synced
// - the winner is the copy that is FURTHER ALONG (lastActivityAt, then completedTurns); file mtime is only a tie-break. Claude rewrites its own,
//   possibly stale, copy whenever a conversation is merely focused, so trusting mtime lets an old record overwrite the newest one everywhere.
// - a conversation deleted in one runtime is deleted in the others, but only as a move to <home>\sync-trash (never destroyed), and a guard
//   refuses to propagate when more than 3 files vanish at once
// - every file that gets overwritten is first copied to <home>\sync-undo (kept 7 days)
// - ending stale `claude.exe --resume=<id>` engine processes is OPT-IN (`recycle: true`); it used to be on and force-killed engines mid-turn
import { readdirSync, statSync, copyFileSync, utimesSync, renameSync, existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, watch, appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { allRuntimes } from './config.mjs';

const FILE = /^local_[0-9a-f-]+\.json$/i;
const dirsIn = d => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(d, e.name)); } catch { return []; } };
const filesIn = d => { try { return readdirSync(d).filter(f => FILE.test(f)); } catch { return []; } };
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const sleepMs = ms => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Every <userData>\claude-code-sessions\<account>\<org> folder that exists. Use one account per runtime. */
export function discoverSides(cfg) {
  const out = [];
  for (const rt of allRuntimes(cfg)) for (const acct of dirsIn(join(rt.userData, 'claude-code-sessions'))) for (const org of dirsIn(acct)) out.push({ runtime: rt.name, dir: org });
  return out;
}

/** How far along a conversation record is. */
function progOf(p) {
  const j = readJson(p); if (!j) return { act: 0, turns: 0 };
  return { act: Number(j.lastActivityAt) || 0, turns: Number(j.completedTurns) || 0 };
}
const cmpProg = (a, b) => (a.act - b.act) || (a.turns - b.turns);   // > 0: a is further along than b
const sameContent = (a, b) => { const x = readJson(a), y = readJson(b); return !!x && !!y && JSON.stringify(x) === JSON.stringify(y); };

function copyAtomic(src, dst, mtime) {
  const tmp = dst + '.sync-tmp';
  copyFileSync(src, tmp); renameSync(tmp, dst); utimesSync(dst, mtime, mtime);
}

export function createSync({ cfg, log = () => {}, recycle = () => [], now = Date.now }) {
  const STATE = join(cfg.home, 'sync-state.json');
  const TRASH = join(cfg.home, 'sync-trash');
  const UNDO = join(cfg.home, 'sync-undo');
  const pending = new Map();      // `${runtime}|${cliId}` -> deferred recycle (only with cfg.recycle)
  const lastRecycle = new Map();
  const sideKey = s => `${s.runtime}|${s.dir}`;

  function backupUndo(p, side) {
    try {
      const d = join(UNDO, new Date(now()).toISOString().slice(0, 10), side.runtime);
      mkdirSync(d, { recursive: true }); copyFileSync(p, join(d, `${basename(p)}.${now()}`));
    } catch (e) { log(`undo backup ERR: ${e.message}`); }
  }
  function pruneUndo() {
    try {
      const cutoff = now() - 7 * 86400000;
      for (const day of readdirSync(UNDO)) { const dp = join(UNDO, day); if (statSync(dp).mtimeMs < cutoff) rmSync(dp, { recursive: true, force: true }); }
    } catch { /* nothing to prune yet */ }
  }
  function toTrash(p, side, f) {
    const d = join(TRASH, new Date(now()).toISOString().slice(0, 10), side.runtime);
    mkdirSync(d, { recursive: true }); copyFileSync(p, join(d, f)); unlinkSync(p);
  }
  const loadState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; } };
  function saveState(sides) {
    const o = {}; for (const s of sides) if (existsSync(s.dir)) o[sideKey(s)] = filesIn(s.dir);
    try { mkdirSync(cfg.home, { recursive: true }); writeFileSync(STATE + '.tmp', JSON.stringify(o)); renameSync(STATE + '.tmp', STATE); } catch (e) { log(`state save ERR: ${e.message}`); }
  }

  // A file that was present on a side after the previous pass and is gone now was deleted there by the user.
  function propagateDeletes(sides) {
    const prev = loadState(); if (!prev) return 0;
    let n = 0;
    for (const s of sides) {
      const before = prev[sideKey(s)]; if (!before || !existsSync(s.dir)) continue;
      const have = new Set(filesIn(s.dir));
      const gone = before.filter(f => !have.has(f)); if (!gone.length) continue;
      if (gone.length > (cfg.deleteGuard ?? 3)) { log(`DELETE-GUARD ${s.runtime}: ${gone.length} files vanished at once; not propagating`); continue; }
      sleepMs(cfg.deleteConfirmMs ?? 1500);   // confirm: a runtime may be in the middle of an atomic rename
      for (const f of gone) {
        if (existsSync(join(s.dir, f))) continue;
        for (const o of sides) {
          if (o === s) continue; const p = join(o.dir, f); if (!existsSync(p)) continue;
          try { toTrash(p, o, f); n++; log(`DELETE ${s.runtime} removed ${f}; moved the ${o.runtime} copy to trash`); } catch (e) { log(`DELETE ERR ${f} on ${o.runtime}: ${e.message}`); }
        }
      }
    }
    return n;
  }

  const doRecycle = (runtime, id, key) => {
    lastRecycle.set(key, now());
    try { const pids = recycle(runtime, id); if (pids.length) log(`recycled stale ${runtime} process pid ${pids.join(',')} for ${id}`); } catch (e) { log(`recycle ERR ${id}: ${e.message}`); }
  };

  function copyAndMaybeRecycle(src, dst, mtime, destSide) {
    const s = readJson(src), d = readJson(dst);
    const destAge = now() - statSync(dst).mtimeMs;   // before the copy: when did the destination runtime last touch its own file?
    backupUndo(dst, destSide);
    copyAtomic(src, dst, mtime);
    const id = s?.cliSessionId;
    if (!cfg.recycle || !id || !d) return;
    if (!(Number(s.lastActivityAt) > Number(d.lastActivityAt) + 1000)) return;   // source did not do real work (focus/title only)
    const key = `${destSide.runtime}|${id}`;
    if (destAge < cfg.busyWindowMs) { pending.set(key, { dst, runtime: destSide.runtime, id, srcLast: Number(s.lastActivityAt) }); log(`defer recycle ${id}: ${destSide.runtime} active ${Math.round(destAge / 1000)}s ago`); return; }
    if (now() - (lastRecycle.get(key) ?? 0) < cfg.recycleCooldownMs) { log(`skip recycle ${id}: cooldown on ${destSide.runtime}`); return; }
    doRecycle(destSide.runtime, id, key);
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
    pruneUndo();
    retryPending();
    const sides = discoverSides(cfg); let n = 0;
    n += propagateDeletes(sides);
    for (const f of new Set(sides.flatMap(s => filesIn(s.dir)))) {
      try {
        const have = sides.map(s => { const p = join(s.dir, f); return existsSync(p) ? { s, p, st: statSync(p) } : { s, p, st: null }; });
        for (const h of have) if (h.st) h.prog = progOf(h.p);
        const src = have.filter(h => h.st).reduce((a, b) => { const c = cmpProg(b.prog, a.prog); return c > 0 ? b : c < 0 ? a : (b.st.mtimeMs > a.st.mtimeMs ? b : a); });
        for (const h of have) {
          if (h === src) continue;
          if (!h.st) { copyAtomic(src.p, h.p, src.st.mtime); log(`${src.s.runtime}->${h.s.runtime} new ${f}`); n++; continue; }
          if (sameContent(src.p, h.p)) continue;   // real content, not mtime/size guesses
          copyAndMaybeRecycle(src.p, h.p, src.st.mtime, h.s); log(`${src.s.runtime}->${h.s.runtime} update ${f}`); n++;
        }
      } catch (e) { log(`ERR ${f}: ${e.message}`); }
    }
    saveState(sides);
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
