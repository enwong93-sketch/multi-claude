import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSync, discoverSides } from '../src/sync.mjs';
import { DEFAULTS } from '../src/config.mjs';

const CLI = '6530f31e-d4f4-484a-9374-b4f940e52948';
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'multi-claude-'));
  const mk = (rt, acct) => { const d = join(root, rt, 'claude-code-sessions', acct, 'org1'); mkdirSync(d, { recursive: true }); return d; };
  const dirs = { A: mk('A', 'acctA'), B: mk('B', 'acctB'), C: mk('C', 'acctC') };
  const cfg = { home: root, ...DEFAULTS, primary: { name: 'A', userData: join(root, 'A') }, runtimes: [{ name: 'B', profile: join(root, 'B') }, { name: 'C', profile: join(root, 'C') }] };
  return { root, dirs, cfg };
}
const put = (dir, id, data, ageMs, now) => {
  const f = join(dir, `local_${id}.json`); writeFileSync(f, JSON.stringify(data));
  const t = new Date(now - ageMs); utimesSync(f, t, t); return f;
};
const sess = (last, extra = {}) => ({ sessionId: 'local_x', cliSessionId: CLI, lastActivityAt: last, title: 't', ...extra });

test('discovers one side per runtime', () => {
  const { cfg } = setup();
  assert.deepEqual(discoverSides(cfg).map(s => s.runtime).sort(), ['A', 'B', 'C']);
});

test('a new conversation reaches every other runtime', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  put(dirs.A, 'aaaa', sess(now), 0, now);
  const n = createSync({ cfg, now: () => now }).syncOnce();
  assert.equal(n, 2);
  for (const r of ['B', 'C']) assert.equal(JSON.parse(readFileSync(join(dirs[r], 'local_aaaa.json'), 'utf8')).cliSessionId, CLI);
  assert.equal(createSync({ cfg, now: () => now }).syncOnce(), 0, 'second pass is a no-op (no ping-pong)');
});

test('newest copy wins and stale processes of the other runtimes are ended', () => {
  const { dirs, cfg } = setup(); const now = Date.now(); const calls = [];
  put(dirs.A, 'aaaa', sess(1000), 3600e3, now);
  put(dirs.B, 'aaaa', sess(2000), 3600e3, now);
  put(dirs.C, 'aaaa', sess(9000), 600e3, now);       // C worked on it most recently, ten minutes ago
  createSync({ cfg, now: () => now, recycle: (rt, id) => { calls.push([rt, id]); return [1]; } }).syncOnce();
  assert.deepEqual(calls.sort(), [['A', CLI], ['B', CLI]]);
  assert.equal(JSON.parse(readFileSync(join(dirs.A, 'local_aaaa.json'), 'utf8')).lastActivityAt, 9000);
});

test('a runtime that was just active is not interrupted; it is recycled once it has been idle', () => {
  const { dirs, cfg } = setup(); let t = Date.now(); const calls = [];
  put(dirs.A, 'aaaa', sess(1000), 10e3, t);          // A touched its file 10 s ago: busy
  put(dirs.B, 'aaaa', sess(5000), 0, t);             // B is newer
  const s = createSync({ cfg, now: () => t, recycle: (rt) => { calls.push(rt); return [1]; } });
  s.syncOnce();
  assert.deepEqual(calls.filter(r => r === 'A'), [], 'deferred while busy');
  t += cfg.busyWindowMs + 5000;                       // time passes, A stays idle
  utimesSync(join(dirs.A, 'local_aaaa.json'), new Date(t - cfg.busyWindowMs - 1000), new Date(t - cfg.busyWindowMs - 1000));
  s.syncOnce();
  assert.ok(calls.includes('A'), 'recycled after idle');
});

test('focus-only changes (same lastActivityAt) never end a process', () => {
  const { dirs, cfg } = setup(); const now = Date.now(); const calls = [];
  put(dirs.A, 'aaaa', sess(5000, { lastFocusedAt: 1 }), 3600e3, now);
  put(dirs.B, 'aaaa', sess(5000, { lastFocusedAt: 2 }), 1800e3, now);
  createSync({ cfg, now: () => now, recycle: (rt) => { calls.push(rt); return [1]; } }).syncOnce();
  assert.deepEqual(calls, []);
});

test('never deletes and never syncs scheduled-tasks.json', () => {
  const { dirs, cfg } = setup(); const now = Date.now();
  writeFileSync(join(dirs.A, 'scheduled-tasks.json'), '{}');
  put(dirs.A, 'aaaa', sess(1), 0, now);
  createSync({ cfg, now: () => now }).syncOnce();
  assert.ok(!existsSync(join(dirs.B, 'scheduled-tasks.json')));
  assert.ok(readdirSync(dirs.A).includes('local_aaaa.json'));
});
