import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSync, discoverSides } from '../src/sync.mjs';
import { DEFAULTS } from '../src/config.mjs';

const CLI = '6530f31e-d4f4-484a-9374-b4f940e52948';
function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'multi-claude-'));
  const mk = (rt, acct) => { const d = join(root, rt, 'claude-code-sessions', acct, 'org1'); mkdirSync(d, { recursive: true }); return d; };
  const dirs = { A: mk('A', 'acctA'), B: mk('B', 'acctB'), C: mk('C', 'acctC') };
  const cfg = { home: root, ...DEFAULTS, deleteConfirmMs: 0, ...extra, primary: { name: 'A', userData: join(root, 'A') }, runtimes: [{ name: 'B', profile: join(root, 'B') }, { name: 'C', profile: join(root, 'C') }] };
  return { root, dirs, cfg };
}
const put = (dir, id, data, ageMs, now) => {
  const f = join(dir, `local_${id}.json`); writeFileSync(f, JSON.stringify(data));
  const t = new Date(now - ageMs); utimesSync(f, t, t); return f;
};
const sess = (last, extra = {}) => ({ sessionId: 'local_x', cliSessionId: CLI, lastActivityAt: last, title: 't', ...extra });
const read = (dir, id) => JSON.parse(readFileSync(join(dir, `local_${id}.json`), 'utf8'));
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test('discovers one side per runtime', () => {
  const { cfg } = setup();
  assert.deepEqual(discoverSides(cfg).map(s => s.runtime).sort(), ['A', 'B', 'C']);
});

test('a new conversation reaches every other runtime and a second pass is a no-op', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  put(dirs.A, 'aaaa', sess(now), 0, now);
  assert.equal(createSync({ cfg, now: () => now }).syncOnce(), 2);
  for (const r of ['B', 'C']) assert.equal(read(dirs[r], 'aaaa').cliSessionId, CLI);
  assert.equal(createSync({ cfg, now: () => now }).syncOnce(), 0, 'no ping-pong');
});

test('the copy that is further along wins even when its file is OLDER', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  put(dirs.A, 'aaaa', sess(9000, { completedTurns: 12 }), 3600e3, now);   // real progress, old mtime
  put(dirs.B, 'aaaa', sess(2000, { completedTurns: 3 }), 0, now);        // stale record rewritten just now (fresh mtime)
  put(dirs.C, 'aaaa', sess(5000, { completedTurns: 7 }), 600e3, now);
  createSync({ cfg, now: () => now }).syncOnce();
  for (const r of ['A', 'B', 'C']) assert.equal(read(dirs[r], 'aaaa').lastActivityAt, 9000, `${r} must hold the newest progress`);
});

test('equal progress: newest mtime decides (focus-only changes)', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  put(dirs.A, 'aaaa', sess(5000, { lastFocusedAt: 1 }), 3600e3, now);
  put(dirs.B, 'aaaa', sess(5000, { lastFocusedAt: 2 }), 60e3, now);
  createSync({ cfg, now: () => now }).syncOnce();
  assert.equal(read(dirs.A, 'aaaa').lastFocusedAt, 2);
});

test('a deleted conversation is removed everywhere, as a move to the trash', () => {
  const { dirs, cfg, root } = setup(); const now = Date.now();
  put(dirs.A, 'aaaa', sess(1), 0, now);
  createSync({ cfg, now: () => now }).syncOnce();                         // mirrored, state saved
  unlinkSync(join(dirs.B, 'local_aaaa.json'));                              // the user deletes it in B
  createSync({ cfg, now: () => now }).syncOnce();
  assert.ok(!existsSync(join(dirs.A, 'local_aaaa.json')));
  assert.ok(!existsSync(join(dirs.C, 'local_aaaa.json')));
  assert.equal(walk(join(root, 'sync-trash')).filter(f => f.endsWith('local_aaaa.json')).length, 2, 'both removed copies are kept in the trash');
});

test('the delete guard refuses to propagate when many files vanish at once', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) put(dirs.A, id, sess(1), 0, now);
  createSync({ cfg, now: () => now }).syncOnce();
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) unlinkSync(join(dirs.B, `local_${id}.json`));
  createSync({ cfg, now: () => now }).syncOnce();
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) assert.ok(existsSync(join(dirs.A, `local_${id}.json`)), `${id} survives in A`);
});

test('an overwritten file is copied to the undo folder first', () => {
  const { dirs, cfg, root } = setup(); const now = Date.now();
  put(dirs.A, 'aaaa', sess(1000), 600e3, now);
  put(dirs.B, 'aaaa', sess(9000), 0, now);
  createSync({ cfg, now: () => now }).syncOnce();
  const undo = walk(join(root, 'sync-undo')).filter(f => /local_aaaa\.json\./.test(f));
  assert.ok(undo.length >= 1);
  assert.equal(JSON.parse(readFileSync(undo[0], 'utf8')).lastActivityAt, 1000, 'the undo copy holds the overwritten content');
});

test('no process is ever ended by default', () => {
  const { dirs, cfg } = setup(); const now = Date.now(); const calls = [];
  put(dirs.A, 'aaaa', sess(1000), 3600e3, now);
  put(dirs.B, 'aaaa', sess(9000), 600e3, now);
  createSync({ cfg, now: () => now, recycle: (rt, id) => { calls.push([rt, id]); return [1]; } }).syncOnce();
  assert.deepEqual(calls, []);
});

test('opt-in recycle: idle runtimes are recycled, busy ones deferred, focus-only never', () => {
  const { dirs, cfg } = setup({ recycle: true }); let t = Date.now(); const calls = [];
  const rec = (rt, id) => { calls.push([rt, id]); return [1]; };
  put(dirs.A, 'aaaa', sess(1000), 3600e3, t);
  put(dirs.B, 'aaaa', sess(9000), 600e3, t);
  createSync({ cfg, now: () => t, recycle: rec }).syncOnce();
  assert.ok(calls.some(c => c[0] === 'A'), 'idle A is recycled');
  // busy: A touched its own file 10 s ago
  const b = setup({ recycle: true }); const c2 = [];
  put(b.dirs.A, 'bbbb', sess(1000), 10e3, t);
  put(b.dirs.B, 'bbbb', sess(9000), 0, t);
  const s = createSync({ cfg: b.cfg, now: () => t, recycle: rt => { c2.push(rt); return [1]; } }); s.syncOnce();
  assert.ok(!c2.includes('A'), 'deferred while busy');
  // focus-only
  const f = setup({ recycle: true }); const c3 = [];
  put(f.dirs.A, 'cccc', sess(5000, { lastFocusedAt: 1 }), 3600e3, t);
  put(f.dirs.B, 'cccc', sess(5000, { lastFocusedAt: 2 }), 1800e3, t);
  createSync({ cfg: f.cfg, now: () => t, recycle: rt => { c3.push(rt); return [1]; } }).syncOnce();
  assert.deepEqual(c3, []);
});

test('scheduled-tasks.json is never synced', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  writeFileSync(join(dirs.A, 'scheduled-tasks.json'), '{}');
  put(dirs.A, 'aaaa', sess(1), 0, now);
  createSync({ cfg, now: () => now }).syncOnce();
  assert.ok(!existsSync(join(dirs.B, 'scheduled-tasks.json')));
  assert.ok(readdirSync(dirs.A).includes('local_aaaa.json'));
});

// ---- disk limits ------------------------------------------------------------------------------------------------------------------------
import { pruneTree, fileLogger } from '../src/sync.mjs';
import { statSync } from 'node:fs';

test('undo copies are limited to the newest N per conversation and runtime', () => {
  const { dirs, cfg, root } = setup({ pruneIntervalMs: 0, undoKeepPerFile: 3 }); const t0 = Date.now();
  put(dirs.A, 'aaaa', sess(1), 0, t0);
  createSync({ cfg, now: () => t0 }).syncOnce();                                  // mirrored to B and C
  for (let i = 2; i <= 12; i++) { put(dirs.A, 'aaaa', sess(i * 1000), 0, t0 + i); createSync({ cfg, now: () => t0 + i }).syncOnce(); }
  const kept = walk(join(root, 'sync-undo')).filter(f => /[\/]B[\/]local_aaaa\.json\./.test(f));
  assert.ok(kept.length <= 3, `at most 3 undo copies for B, found ${kept.length}`);
});

test('old undo copies and the trash are pruned by age', () => {
  const { cfg, root } = setup({ pruneIntervalMs: 0, undoKeepDays: 1, trashKeepDays: 14 });
  const u = join(root, 'sync-undo', 'B'); mkdirSync(u, { recursive: true });
  const tr = join(root, 'sync-trash', '2026-01-01', 'B'); mkdirSync(tr, { recursive: true });
  const day = 86400000, now = Date.now();
  const mk = (p, ageDays) => { writeFileSync(p, 'x'); const t = new Date(now - ageDays * day); utimesSync(p, t, t); };
  mk(join(u, 'local_old.json.1-0'), 3); mk(join(u, 'local_new.json.2-0'), 0.1);
  mk(join(tr, 'local_gone-old.json'), 20); mk(join(tr, 'local_gone-new.json'), 2);
  createSync({ cfg, now: () => now }).syncOnce();
  assert.ok(!existsSync(join(u, 'local_old.json.1-0')) && existsSync(join(u, 'local_new.json.2-0')));
  assert.ok(!existsSync(join(tr, 'local_gone-old.json')) && existsSync(join(tr, 'local_gone-new.json')));
});

test('a size cap removes the oldest files first', () => {
  const d = mkdtempSync(join(tmpdir(), 'mc-cap-')); const now = Date.now();
  for (let i = 0; i < 5; i++) { const p = join(d, `f${i}`); writeFileSync(p, Buffer.alloc(1000)); const t = new Date(now - (5 - i) * 1000); utimesSync(p, t, t); }
  pruneTree(d, { capBytes: 2500, now: () => now });
  assert.deepEqual(readdirSync(d).sort(), ['f3', 'f4'], 'only the two newest files fit under the cap');
});

test('the log rotates instead of growing', () => {
  const d = mkdtempSync(join(tmpdir(), 'mc-log-')); const f = join(d, 'sync.log'); const log = fileLogger(f, 2000);
  for (let i = 0; i < 400; i++) log(`line ${i} ${'x'.repeat(40)}`);
  assert.ok(existsSync(f + '.old'), 'rotated once the limit was passed');
  assert.ok(statSync(f).size + statSync(f + '.old').size < 2000 * 3, 'total stays near twice the limit');
});
