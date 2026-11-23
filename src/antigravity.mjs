// Claude Code -> Antigravity conversation export.
// Claude keeps a JSONL transcript per session; Antigravity keeps one SQLite file per conversation (protobuf step records) plus an
// index row in conversation_summaries.db and a small project file. This module rewrites Claude text turns into that format by
// cloning a conversation Antigravity itself wrote (the template), so every field it needs is present and only content changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { decode, encode, find, setText, setVarint, removeField, replaceText, shiftTimestamps, setTimestamp, mapLeaves } from './pb.mjs';

const { DatabaseSync } = await import('node:sqlite');

export const geminiDir = (env = process.env) => join(env.USERPROFILE || env.HOME || homedir(), '.gemini');

// ---------- Claude transcript ----------
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const NOISE_START = /^(<command-(name|message|args|stdout)>|<local-command|Caveat: The messages below|\[Request interrupted)/;

/** Lines of a (possibly multi-hundred-MB) file without loading it whole. */
export function* fileLines(file) {
  const fd = openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); let carry = [];
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null); if (!n) break;
      let start = 0;
      for (let i = 0; i < n; i++) if (buf[i] === 10) { carry.push(Buffer.from(buf.subarray(start, i))); yield Buffer.concat(carry).toString('utf8'); carry = []; start = i + 1; }
      if (start < n) carry.push(Buffer.from(buf.subarray(start, n)));
    }
    if (carry.length) yield Buffer.concat(carry).toString('utf8');
  } finally { closeSync(fd); }
}

export function claudeTurns(lines, { maxMsgChars = 6000 } = {}) {
  const raw = [];
  for (const line of typeof lines === 'string' ? lines.split(/\r?\n/) : lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain || !o.message) continue;
    const c = o.message.content; let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    text = text.replace(REMINDER, '').trim();
    if (!text || NOISE_START.test(text)) continue;
    const ts = Date.parse(o.timestamp || '') || null;
    raw.push({ role: o.type, text, ts, cwd: o.cwd || null });
  }
  const turns = [];
  for (const r of raw) {
    const last = turns[turns.length - 1];
    if (last && last.role === r.role) last.text += '\n\n' + r.text; else turns.push({ ...r });
  }
  for (const t of turns) if (t.text.length > maxMsgChars) t.text = t.text.slice(0, maxMsgChars) + `\n…[truncated ${t.text.length - maxMsgChars} chars]`;
  return turns;
}

export function findTranscript(cliSessionId, env = process.env) {
  const root = join(env.USERPROFILE || env.HOME || homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) { const f = join(root, d, `${cliSessionId}.jsonl`); if (existsSync(f)) return f; }
  return null;
}

// ---------- ids / time ----------
export function stableUuid(seed) {
  const h = createHash('sha1').update('multi-claude/antigravity/' + seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '0000+00:00'); // 7 fractional digits, like Antigravity
const secOf = ms => Math.floor(ms / 1000), nanoOf = ms => (ms % 1000) * 1000000;
export const folderUri = cwd => 'file:///' + String(cwd).replace(/\\/g, '/').replace(/^\/+/, '');
const fwd = p => String(p).replace(/\\/g, '/');

// ---------- template ----------
export function loadTemplate(store) {
  const dir = join(store, 'conversations');
  const cands = readdirSync(dir).filter(f => f.endsWith('.db')).map(f => ({ f, size: statSync(join(dir, f)).size })).sort((a, b) => a.size - b.size);
  for (const c of cands) {
    const tmp = join(store, `.tpl-${process.pid}.db`); copyFileSync(join(dir, c.f), tmp);
    try {
      const d = new DatabaseSync(tmp, { readOnly: true });
      const steps = d.prepare('select * from steps order by idx').all();
      const u = steps.find(s => s.step_type === 14), a = steps.find(s => s.step_type === 15);
      if (!u || !a) { d.close(); continue; }
      const t = {
        convId: c.f.replace(/\.db$/, ''), user: Buffer.from(u.step_payload), assistant: Buffer.from(a.step_payload),
        userRow: u, assistantRow: a,
        meta: d.prepare('select * from trajectory_meta').get(), gen: d.prepare('select * from gen_metadata order by idx limit 1').get(),
        exec: d.prepare('select * from executor_metadata order by idx limit 1').get(), tmb: d.prepare('select * from trajectory_metadata_blob').get(),
        schema: d.prepare("select sql from sqlite_master where sql is not null and name not like 'sqlite_%'").all().map(r => r.sql),
      };
      const sum = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true });
      t.summary = sum.prepare('select * from conversation_summaries where conversation_id=?').get(t.convId); sum.close(); d.close();
      if (!t.summary) continue;
      return t;
    } finally { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }
  }
  throw new Error(`No usable template conversation in ${dir}. Run Antigravity's agy once (e.g. agy -p "hi") so one exists.`);
}

// ---------- build ----------
function userStep(tpl, text, ms, ids, execId) {
  const t = decode(tpl.user); const base = Number(find(t, [5, 1, 1]).v);
  shiftTimestamps(t, secOf(ms) - base); setTimestamp(t, [5, 1], secOf(ms), nanoOf(ms));
  setText(t, [19, 2], text); setText(t, [19, 3, 1], text);
  swapIds(t, tpl, ids, execId);
  return t;
}
function assistantStep(tpl, text, ms, ids, execId) {
  const t = decode(tpl.assistant); const base = Number(find(t, [5, 1, 1]).v);
  shiftTimestamps(t, secOf(ms) - base); setTimestamp(t, [5, 1], secOf(ms), nanoOf(ms));
  setText(t, [20, 1], text); setText(t, [20, 8], text);
  removeField(t, [20, 14]); // opaque model-side token blob of the template reply; it must not travel with different text
  swapIds(t, tpl, ids, execId);
  return t;
}
function swapIds(tree, tpl, ids, execId) {
  const oldExec = find(decode(tpl.user), [5, 12])?.v.toString('utf8');
  mapLeaves(tree, n => {
    if (n.w !== 2) return;
    const s = n.v.toString('utf8');
    if (s === tpl.meta.trajectory_id) return ids.traj;
    if (s === tpl.meta.cascade_id) return ids.conv;
    if (oldExec && s === oldExec) return execId;
    if (/^[0-9a-f]{32}$/.test(s)) return randomBytes(16).toString('hex');
  });
}
function retarget(tree, tpl, ids, cwd) {
  mapLeaves(tree, n => {
    if (n.w !== 2) return; const s = n.v.toString('utf8');
    if (s === tpl.meta.trajectory_id) return ids.traj; if (s === tpl.meta.cascade_id) return ids.conv;
  });
  if (cwd) { const oldWs = (JSON.parse(tpl.summary.workspace_uris || '[]')[0] || '').replace(/^file:\/\/\//, ''); if (oldWs) { replaceText(tree, oldWs, fwd(cwd)); } }
}

export function buildConversation({ tpl, turns, convId, cwd, projectId, title, outFile }) {
  const ids = { conv: convId, traj: stableUuid('traj/' + convId), run: stableUuid('run/' + convId) };
  const t0 = turns[0].ts || Date.now();
  const stamped = turns.map((t, i) => ({ ...t, ts: t.ts || t0 + i * 1000 })).map((t, i, a) => ({ ...t, ts: Math.max(t.ts, i ? a[i - 1].ts + 1 : t.ts) }));
  const tmp = outFile + '.tmp'; rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  for (const sql of tpl.schema) db.exec(sql);
  const insStep = db.prepare('insert into steps (idx,step_type,status,has_subtrajectory,metadata,error_details,permissions,task_details,render_info,step_payload,step_format) values (?,?,?,?,?,?,?,?,?,?,?)');
  let exec = randomUUID(), idx = 0, lastUser = null;
  for (const t of stamped) {
    if (t.role === 'user') exec = randomUUID();
    const tree = (t.role === 'user' ? userStep : assistantStep)(tpl, t.text, t.ts, ids, exec);
    retarget(tree, tpl, ids, cwd);
    const row = t.role === 'user' ? tpl.userRow : tpl.assistantRow;
    const payload = encode(tree); const meta = find(tree, [5]);
    insStep.run(idx, row.step_type, row.status, row.has_subtrajectory, meta ? encode(meta.kids) : null, null, null, null, null, payload, row.step_format);
    if (t.role === 'user') lastUser = { ts: t.ts, idx };
    idx++;
  }
  db.prepare('insert into trajectory_meta (trajectory_id,cascade_id,trajectory_type,source) values (?,?,?,?)').run(ids.traj, ids.conv, tpl.meta.trajectory_type, tpl.meta.source);
  if (tpl.gen) db.prepare('insert into gen_metadata (idx,data,size) values (?,?,?)').run(tpl.gen.idx, tpl.gen.data, tpl.gen.size);
  if (tpl.exec) { const e = decode(Buffer.from(tpl.exec.data)); retarget(e, tpl, ids, cwd); db.prepare('insert into executor_metadata (idx,data) values (?,?)').run(tpl.exec.idx, encode(e)); }
  if (tpl.tmb) { const m = decode(Buffer.from(tpl.tmb.data)); retarget(m, tpl, ids, cwd); setText(m, [18], projectId); setText(m, [3], ids.run); shiftTimestamps(m, secOf(t0) - firstSec(m, secOf(t0))); db.prepare('insert into trajectory_metadata_blob (id,data) values (?,?)').run(tpl.tmb.id, encode(m)); }
  db.close();
  renameSync(tmp, outFile);

  // index row
  const first = stamped[0], last = stamped[stamped.length - 1];
  const sm = decode(Buffer.from(tpl.summary.raw_summary)); retarget(sm, tpl, ids, cwd);
  shiftTimestamps(sm, secOf(t0) - firstSec(sm, secOf(t0)));
  setText(sm, [1], title); setVarint(sm, [2], stamped.length);
  setTimestamp(sm, [3], secOf(last.ts), nanoOf(last.ts)); setTimestamp(sm, [7], secOf(first.ts), nanoOf(first.ts)); setTimestamp(sm, [10], secOf((lastUser || first).ts), nanoOf((lastUser || first).ts));
  setText(sm, [15, 1], title); setText(sm, [17, 18], projectId);
  setText(sm, [17, 3], ids.run);
  return { ids, count: stamped.length, last, lastUser: lastUser || { ts: first.ts, idx: 0 }, raw: encode(sm), preview: stamped.find(t => t.role === 'user')?.text.slice(0, 120) || title };
}
function firstSec(nodes, dflt) { let found = null; const walk = ns => { for (const n of ns) { if (found) return; if (n.kids) { const k = n.kids; if (k.length === 2 && k[0].f === 1 && k[1].f === 2 && k[0].w === 0 && k[0].v > 1500000000n && k[0].v < 2500000000n) { found = Number(k[0].v); return; } walk(k); } } }; walk(nodes); return found ?? dflt; }

// ---------- projects & index ----------
export function ensureProject(cwd, env = process.env) {
  const dir = join(geminiDir(env), 'config', 'projects'); mkdirSync(dir, { recursive: true });
  const want = fwd(cwd).toLowerCase().replace(/\/+$/, '');
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^﻿/, '')); const u = (j.projectResources?.resources || []).map(r => String(r.folderUri || '').replace(/^file:\/+/, '').toLowerCase().replace(/\/+$/, ''));
      if (u.includes(want)) return j.id; } catch { /* skip */ }
  }
  const id = stableUuid('project/' + want);
  writeFileSync(join(dir, id + '.json'), JSON.stringify({ id, name: basename(cwd) || cwd, projectResources: { resources: [{ folderUri: 'file://' + fwd(cwd) }] } }, null, 2));
  return id;
}

export function upsertSummary(store, tpl, convId, built, cwd, projectId, title) {
  const db = new DatabaseSync(join(store, 'conversation_summaries.db')); db.exec('PRAGMA busy_timeout=8000');
  const s = tpl.summary; const lm = sqlTime(built.last.ts), lu = sqlTime(built.lastUser.ts);
  db.prepare('delete from conversation_summaries where conversation_id=?').run(convId);
  db.prepare(`insert into conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,source,project_id,agent_name,parent_conversation_id,nesting_depth,battle_id,winning_conversation_id,not_fully_idle,killed,last_user_input_time,last_user_input_step_index,app_data_dir,raw_summary,group_id)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(convId, title, title, built.count, lm, JSON.stringify(cwd ? [folderUri(cwd)] : []), s.status, s.source, projectId, '', '', 0, '', '', 0, 0, lu, s.last_user_input_step_index, basename(store), built.raw, '');
  db.close();
}

function stepCount(file) {
  try { const tmp = file + '.cnt'; copyFileSync(file, tmp); const d = new DatabaseSync(tmp, { readOnly: true }); const n = d.prepare('select count(*) n from steps').get().n; d.close(); rmSync(tmp, { force: true }); return n; } catch { return 0; }
}

/** The Antigravity stores to write: the agy CLI store (so agy can resume) and the desktop app's store (so the app lists them). */
export function defaultStores(env = process.env) {
  const g = geminiDir(env);
  return [join(g, 'antigravity-cli'), join(g, 'antigravity')].filter(d => existsSync(join(d, 'conversation_summaries.db')));
}

// ---------- orchestration ----------
export function exportSessions({ stores, sessions, state, log = () => {}, maxTurns = 400, maxMsgChars = 6000, dryRun = false, env = process.env }) {
  if (!stores?.length) throw new Error('No Antigravity store found (expected ~/.gemini/antigravity and/or ~/.gemini/antigravity-cli).');
  const tpl = loadTemplate(stores[0]); const out = { exported: 0, skipped: 0, missing: 0, keptAntigravityEdits: 0 };
  for (const st of stores) mkdirSync(join(st, 'conversations'), { recursive: true });
  for (const s of sessions) {
    const file = findTranscript(s.cliSessionId, env);
    if (!file) { out.missing++; continue; }
    const mt = statSync(file).mtimeMs; const prev = state[s.cliSessionId];
    const convId = prev?.convId || stableUuid('conv/' + s.cliSessionId);
    if (prev && prev.mtime >= mt && stores.every(st => existsSync(join(st, 'conversations', convId + '.db')))) { out.skipped++; continue; }
    // Never overwrite a conversation that was continued inside Antigravity (more steps than we wrote).
    const grown = prev && stores.some(st => stepCount(join(st, 'conversations', convId + '.db')) > prev.turns);
    if (grown) { out.keptAntigravityEdits++; log(`kept ${convId}: it was continued in Antigravity`); continue; }
    let turns = claudeTurns(fileLines(file), { maxMsgChars });
    if (turns.length > maxTurns) turns = turns.slice(-maxTurns);
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (!turns.some(t => t.role === 'assistant')) { out.skipped++; continue; }
    if (!prev && stores.some(st => stepCount(join(st, 'conversations', convId + '.db')) > turns.length)) { out.keptAntigravityEdits++; continue; }
    const cwd = s.cwd || turns.find(t => t.cwd)?.cwd || homedir();
    const title = (s.title || turns[0].text.split('\n')[0]).slice(0, 80);
    if (dryRun) { log(`would export ${s.cliSessionId} -> ${convId} (${turns.length} turns) ${title}`); out.exported++; continue; }
    const projectId = ensureProject(cwd, env);
    const first = join(stores[0], 'conversations', convId + '.db');
    const built = buildConversation({ tpl, turns, convId, cwd, projectId, title, outFile: first });
    for (const st of stores) {
      const f = join(st, 'conversations', convId + '.db');
      if (st !== stores[0]) { copyFileSync(first, f + '.tmp'); renameSync(f + '.tmp', f); }
      for (const sub of ['.system_generated', '.user_uploaded', 'scratch']) mkdirSync(join(st, 'brain', convId, sub), { recursive: true });
      upsertSummary(st, tpl, convId, built, cwd, projectId, title); // index row last: it only points at data that already exists
    }
    state[s.cliSessionId] = { convId, mtime: mt, turns: turns.length };
    log(`exported ${s.cliSessionId} -> ${convId} (${turns.length} turns)`); out.exported++;
  }
  return out;
}
