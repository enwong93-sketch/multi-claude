// Claude Code -> Antigravity conversation export.
// Claude keeps a JSONL transcript per session; Antigravity keeps one SQLite file per conversation (protobuf step records) plus an
// index row in conversation_summaries.db and a small project file. This module rewrites Claude text turns into that format by
// cloning a conversation Antigravity itself wrote (the template), so every field it needs is present and only content changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { decode, encode, find, setText, setVarint, removeField, replaceText, shiftTimestamps, setTimestamp, mapLeaves } from './pb.mjs';

const { DatabaseSync } = await import('node:sqlite');

export const geminiDir = (env = process.env) => join(env.USERPROFILE || env.HOME || homedir(), '.gemini');

// ---------- Claude transcript ----------
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const NOISE_START = /^(<command-(name|message|args|stdout)>|<local-command|Caveat: The messages below|\[Request interrupted)/;

/** Lines of a (possibly multi-hundred-MB) file without loading it whole. */
export function* fileLines(file, maxBytes = Infinity) {
  const fd = openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); let carry = [];
  let remaining = maxBytes;
  try {
    while (remaining > 0) {
      const n = readSync(fd, buf, 0, Math.min(remaining, buf.length), null); if (!n) break;
      remaining -= n;
      let start = 0;
      for (let i = 0; i < n; i++) if (buf[i] === 10) { carry.push(Buffer.from(buf.subarray(start, i))); yield Buffer.concat(carry).toString('utf8'); carry = []; start = i + 1; }
      if (start < n) carry.push(Buffer.from(buf.subarray(start, n)));
    }
    if (carry.length) yield Buffer.concat(carry).toString('utf8');
  } finally { closeSync(fd); }
}

export function claudeTurns(lines, { maxMsgChars = 6000 } = {}) {
  const turns = [];
  for (const line of typeof lines === 'string' ? lines.split(/\r?\n/) : lines) {
    const r = claudeMessage(line);
    if (!r) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === r.role) {
      last.text += '\n\n' + r.text;
      last.ts = Math.max(last.ts || 0, r.ts || 0) || null;
    } else turns.push(r);
  }
  for (const t of turns) if (t.text.length > maxMsgChars) t.text = t.text.slice(0, maxMsgChars) + `\n…[truncated ${t.text.length - maxMsgChars} chars]`;
  return turns;
}

function claudeMessage(line) {
  let o; try { o = JSON.parse(line); } catch { return null; }
  return visibleClaudeRecord(o);
}

export function visibleClaudeRecord(o) {
  if (!o || (o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain || !o.message) return null;
  const content = o.message.content;
  let text = typeof content === 'string' ? content : '';
  if (Array.isArray(content)) text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  text = text.replace(REMINDER, '').replace(/^\s*<!--\s*attach\s*-->\s*/, '').trim();
  if (!text || NOISE_START.test(text) || text.startsWith('<task-notification>')) return null;
  return { role: o.type, text, ts: Date.parse(o.timestamp || '') || null, cwd: o.cwd || null };
}

export function findTranscript(cliSessionId, env = process.env) {
  if (!/^[0-9a-z_-]+$/i.test(cliSessionId || '')) return null;
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
export const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '0000+00:00'); // 7 fractional digits, like Antigravity
const secOf = ms => Math.floor(ms / 1000), nanoOf = ms => (ms % 1000) * 1000000;
export const folderUri = cwd => 'file:///' + String(cwd).replace(/\\/g, '/').replace(/^\/+/, '');
const fwd = p => String(p).replace(/\\/g, '/');

// ---------- template ----------
export function loadTemplate(store) {
  const dir = join(store, 'conversations');
  const cands = readdirSync(dir).filter(f => f.endsWith('.db')).map(f => ({ f, size: statSync(join(dir, f)).size })).sort((a, b) => a.size - b.size);
  for (const c of cands) {
    const d = new DatabaseSync(join(dir, c.f), { readOnly: true });
    try {
      const steps = d.prepare('select * from steps order by idx').all();
      const u = steps.find(s => s.step_type === 14), a = steps.find(s => s.step_type === 15);
      if (!u || !a) continue;
      const t = {
        convId: c.f.replace(/\.db$/, ''), user: Buffer.from(u.step_payload), assistant: Buffer.from(a.step_payload),
        userRow: u, assistantRow: a,
        meta: d.prepare('select * from trajectory_meta').get(), gen: d.prepare('select * from gen_metadata order by idx limit 1').get(),
        exec: d.prepare('select * from executor_metadata order by idx limit 1').get(), tmb: d.prepare('select * from trajectory_metadata_blob').get(),
        schema: d.prepare("select sql from sqlite_master where sql is not null and name not like 'sqlite_%'").all().map(r => r.sql),
      };
      const sum = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true });
      try { t.summary = sum.prepare('select * from conversation_summaries where conversation_id=?').get(t.convId); }
      finally { sum.close(); }
      if (!t.summary) continue;
      return t;
    } finally { d.close(); }
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
  // Antigravity treats a trajectory file as "not initialized" unless it carries the same SQLite header settings it writes itself.
  db.exec('PRAGMA page_size=32768; PRAGMA journal_mode=WAL; PRAGMA user_version=1;');
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

// ---------- index ----------
export function upsertSummary(store, tpl, convId, built, cwd, projectId, title) {
  const db = new DatabaseSync(join(store, 'conversation_summaries.db')); db.exec('PRAGMA busy_timeout=8000');
  const s = tpl.summary; const lm = sqlTime(built.last.ts), lu = sqlTime(built.lastUser.ts);
  db.prepare('delete from conversation_summaries where conversation_id=?').run(convId);
  db.prepare(`insert into conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,source,project_id,agent_name,parent_conversation_id,nesting_depth,battle_id,winning_conversation_id,not_fully_idle,killed,last_user_input_time,last_user_input_step_index,app_data_dir,raw_summary,group_id)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(convId, title, title, built.count, lm, (cwd ? JSON.stringify([folderUri(cwd)]) : ''), s.status, s.source, projectId, '', '', 0, '', '', 0, 0, lu, built.lastUser.idx, basename(store), built.raw, '');
  db.close();
}

export function desktopAppRunning() {
  try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).toLowerCase().includes('antigravity.exe'); } catch { return false; }
}

/** The desktop hub keeps its own cache of summaries (agyhub_summaries_proto.pb) and trusts it over our index rows. With the app closed,
 *  removing our entries makes it rebuild them from the conversation files on the next start. */
export function dropFromHubCache(dir, ids, beforeWrite = () => {}) {
  const f = join(dir, 'agyhub_summaries_proto.pb'); if (!existsSync(f)) return 0;
  const nodes = decode(readFileSync(f)); const set = new Set(ids);
  const keep = nodes.filter(n => !(n.kids && n.kids[0] && set.has(n.kids[0].v.toString('utf8'))));
  if (keep.length === nodes.length) return 0;
  const tmp = f + '.' + process.pid + '.tmp';
  try {
    writeFileSync(tmp, encode(keep), { flag: 'wx', flush: true });
    beforeWrite();
    renameSync(tmp, f);
  } finally { rmSync(tmp, { force: true }); }
  return (nodes.length - keep.length) / 2;
}

function deleteSummary(store, convId) {
  const db = new DatabaseSync(join(store, 'conversation_summaries.db')); db.exec('PRAGMA busy_timeout=8000');
  db.prepare('delete from conversation_summaries where conversation_id=?').run(convId); db.close();
}

function stepCount(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare('select count(*) n from steps').get().n; }
  finally { d.close(); }
}

/** Stores to write. By default only the desktop app's store (~/.gemini/antigravity), built from a desktop-native template
 *  (trajectory source 1, kept in ~/.gemini/antigravity-ide): the desktop app lists only conversations that look desktop-made.
 *  The agy CLI store is opt-in and uses different conversation ids: the desktop hub also reads that store and a CLI-sourced copy
 *  with the same id would override the desktop one (and be hidden). */
export function defaultStores(env = process.env, { cli = false } = {}) {
  const g = geminiDir(env); const ok = d => existsSync(join(d, 'conversation_summaries.db'));
  const cliDir = join(g, 'antigravity-cli'), hub = join(g, 'antigravity'), ide = join(g, 'antigravity-ide');
  const out = [];
  if (ok(hub)) out.push({ dir: hub, templateDir: ok(ide) ? ide : hub, salt: 'conv/' });
  if (cli && ok(cliDir)) out.push({ dir: cliDir, templateDir: cliDir, salt: 'conv-cli/' });
  return out;
}

// ---------- orchestration ----------
function transcriptSegments(session, file, env) {
  const segments = [{ id: session.cliSessionId, file }];
  const seen = new Set([session.cliSessionId]);
  for (let child = segments[0];;) {
    const edge = (session.rewinds || []).find(e => e?.child === child.id &&
      session.priorCliSessionIds?.includes(e.parent) && /^[\da-f-]{36}$/i.test(e.forkPoint || ''));
    if (!edge || seen.has(edge.parent)) break;
    const parentFile = findTranscript(edge.parent, env);
    if (!parentFile) break;
    child.after = edge.forkPoint;
    child = { id: edge.parent, file: parentFile, through: edge.forkPoint };
    seen.add(child.id);
    segments.unshift(child);
  }
  return segments;
}

function atMessage(line, id) {
  if (!id || !line.includes(id)) return false;
  try { return JSON.parse(line)?.uuid === id; } catch { return false; }
}

function* segmentLines(segments) {
  for (const segment of segments) {
    let started = !segment.after;
    let finished = !segment.through;
    for (const line of fileLines(segment.file, segment.size)) {
      if (!started) { started = atMessage(line, segment.after); continue; }
      yield line;
      if (atMessage(line, segment.through)) { finished = true; break; }
    }
    if (!started || !finished) throw new Error(`rewind marker missing from ${segment.id}`);
  }
}

function sourceAncestors(segments) {
  return JSON.stringify(segments.slice(0, -1).map(segment => {
    const stat = statSync(segment.file);
    return [segment.id, segment.after, segment.through, stat.size, stat.mtimeMs];
  }));
}

function nativeTurn(row) {
  const tree = decode(Buffer.from(row.step_payload));
  if (row.step_type === 14) return { role: 'user', text: find(tree, [19, 2])?.v.toString(), tree };
  if (row.step_type === 15) return { role: 'assistant', text: find(tree, [20, 1])?.v.toString(), tree };
  throw new Error('Native history contains steps outside the Claude import.');
}

export function readNativeText(file, { includeMetadata = false } = {}) {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
  try {
    const rows = db.prepare('select idx,step_type,status,step_payload from steps order by idx');
    return Array.from(rows.iterate(), row => {
      const metadata = includeMetadata ? { type: row.step_type, status: row.status } : {};
      if (includeMetadata && row.step_type === 17) {
        const reason = find(decode(Buffer.from(row.step_payload)), [24, 3, 2])?.v.toString();
        metadata.quota = /^RESOURCE_EXHAUSTED \(code 429\)/.test(reason ?? '');
      }
      if (row.step_type !== 14 && row.step_type !== 15) return { index: row.idx, ...metadata };
      const { role, text, tree } = nativeTurn(row);
      const seconds = find(tree, [5, 1, 1]);
      const nanos = find(tree, [5, 1, 2]);
      const ts = seconds ? Number(seconds.v) * 1000 + Math.floor(Number(nanos?.v || 0n) / 1e6) : null;
      return { index: row.idx, role, text, ts, completed: row.status === 3, ...metadata };
    });
  } finally { db.close(); }
}

export function projectNativeText(rows) {
  const turns = [];
  for (const row of rows) {
    if (!row.role || !row.text) continue;
    const last = turns.at(-1);
    if (last?.role === row.role) {
      last.text += '\n\n' + row.text;
      last.ts = Math.max(last.ts || 0, row.ts || 0) || null;
      last.completed &&= row.completed;
      last.index = row.index;
    } else turns.push({ ...row });
  }
  return turns;
}

export function appendNativeTurns(file, convId, tpl, previous, turns, beforeCommit = () => {}) {
  const d = new DatabaseSync(file, { timeout: 3000 });
  try {
    d.exec('begin immediate');
    const all = d.prepare('select idx,step_type,step_payload from steps order by idx').all();
    const native = projectNativeText(all.filter(row => row.step_type === 14 || row.step_type === 15)
      .map(row => ({ ...nativeTurn(row), index: row.idx })));
    const count = native.length;
    let extendLast = false;
    for (const [i, existing] of native.entries()) {
      const source = turns[i];
      if (source?.role === existing.role && source.text === existing.text) continue;
      if (i === previous.turns - 1 && i === count - 1 && existing.index === all.at(-1).idx && existing.text &&
          source?.role === existing.role && source.text.startsWith(existing.text + '\n\n')) {
        extendLast = true;
        continue;
      }
      throw new Error('Native history diverged or Claude rewound. Retaining the existing trajectory.');
    }
    if (count !== previous.turns && count !== turns.length) throw new Error('Native step count changed.');
    if (count === turns.length && !extendLast) { d.exec('rollback'); return false; }
    const m = d.prepare('select trajectory_id from trajectory_meta').get();
    const ids = { conv: convId, traj: m.trajectory_id };
    const lastRow = all.find(row => row.idx === native.at(-1).index);
    const last = nativeTurn(lastRow);
    const stamp = find(last.tree, [5, 1]);
    let ms = Number(find(stamp.kids, [1]).v) * 1000 + Number(find(stamp.kids, [2])?.v || 0n) / 1e6;
    let execution = find(last.tree, [5, 12])?.v.toString() || randomUUID();
    if (extendLast) {
      const t = turns[count - 1];
      const extended = last.text + t.text.slice(native.at(-1).text.length);
      if (t.role === 'user') { setText(last.tree, [19, 2], extended); setText(last.tree, [19, 3, 1], extended); }
      else { setText(last.tree, [20, 1], extended); setText(last.tree, [20, 8], extended); }
      ms = Math.max(ms, t.ts || ms);
      setTimestamp(last.tree, [5, 1], secOf(ms), nanoOf(ms));
      d.prepare('update steps set step_payload=?,metadata=? where idx=?').run(encode(last.tree), encode(find(last.tree, [5]).kids), lastRow.idx);
    }
    const ins = d.prepare('insert into steps (idx,step_type,status,has_subtrajectory,metadata,step_payload,step_format) values (?,?,?,?,?,?,?)');
    const firstIndex = all.at(-1).idx + 1;
    for (let i = count; i < turns.length; i++) {
      const turn = turns[i];
      if (turn.role === 'user') execution = randomUUID();
      ms = Math.max(ms + 1, turn.ts || ms);
      const tree = (turn.role === 'user' ? userStep : assistantStep)(tpl, turn.text, ms, ids, execution);
      const tRow = turn.role === 'user' ? tpl.userRow : tpl.assistantRow;
      ins.run(firstIndex + i - count, tRow.step_type, tRow.status, tRow.has_subtrajectory, encode(find(tree, [5]).kids), encode(tree), tRow.step_format);
    }
    beforeCommit();
    d.exec('commit');
    return true;
  } catch (e) {
    if (d.isTransaction) d.exec('rollback');
    throw e;
  } finally { d.close(); }
}

export function exportSessions({ stores: rawStores, sessions, state, log = () => {}, maxTurns = Infinity, maxMsgChars = Infinity,
  maxHistoryBytes = Infinity, dryRun = false, env = process.env }) {
  const stores = (rawStores || []).map(x => (typeof x === 'string' ? { dir: x, templateDir: x, salt: 'conv/' } : x));
  if (!stores.length) throw new Error('No Antigravity store found (expected ~/.gemini/antigravity and/or ~/.gemini/antigravity-cli).');
  const out = { exported: 0, skipped: 0, missing: 0, keptAntigravityEdits: 0, deferredSourceSwitch: 0 };
  const tpls = new Map(); const tplOf = st => { if (!tpls.has(st.templateDir)) tpls.set(st.templateDir, loadTemplate(st.templateDir)); return tpls.get(st.templateDir); };
  const writesHub = !dryRun && stores.some(st => basename(st.dir) === 'antigravity');
  if (writesHub && desktopAppRunning()) {
    throw new Error('Close Antigravity before a full native export. Use agy-live for incremental synchronization.');
  }
  if (!dryRun) for (const st of stores) mkdirSync(join(st.dir, 'conversations'), { recursive: true });
  const cf = (st, id) => join(st.dir, 'conversations', id + '.db');
  for (const s of sessions) {
    const file = findTranscript(s.cliSessionId, env);
    if (!file) { out.missing++; continue; }
    const segments = transcriptSegments(s, file, env);
    const ancestors = JSON.stringify(segments.slice(0, -1).map(segment => {
      const stat = statSync(segment.file);
      return [segment.id, segment.after, segment.through, stat.size, stat.mtimeMs];
    }));
    const key = [s.cliSessionId, ...(s.priorCliSessionIds || []).slice().reverse()].find(id => state[id]) || s.cliSessionId;
    const { mtimeMs: mt, size } = statSync(file);
    const prev = state[key];
    const idOf = st => stableUuid(st.salt + key);
    const exists = st => existsSync(cf(st, idOf(st)));
    if (prev?.sourceId === s.cliSessionId && prev.mtime === mt && prev.size === size && (prev.ancestors || '[]') === ancestors &&
        prev.full === (maxTurns === Infinity && maxMsgChars === Infinity && maxHistoryBytes === Infinity) &&
        stores.every(exists)) { out.skipped++; continue; }
    // Never overwrite a conversation that was continued inside Antigravity (more steps than we wrote).
    if (prev && stores.some(st => exists(st) && stepCount(cf(st, idOf(st))) > prev.turns)) { out.keptAntigravityEdits++; log(`kept ${s.cliSessionId}: it was continued in Antigravity`); continue; }
    if (!segments.some(segment => segment.id === key) && stores.some(exists)) {
      out.deferredSourceSwitch++;
      log(`kept ${key}: source switched to ${s.cliSessionId} without a matching history checkpoint`);
      continue;
    }
    let turns;
    try { turns = claudeTurns(segmentLines(segments), { maxMsgChars }); }
    catch (e) { out.deferredSourceSwitch++; log(`kept ${key}: ${e.message}`); continue; }
    if (turns.length > maxTurns) turns = turns.slice(-maxTurns);
    let remaining = maxHistoryBytes;
    let start = turns.length;
    for (; start > 0; start--) {
      remaining -= Buffer.byteLength(turns[start-1].text);
      if (remaining < 0) break;
    }
    turns = turns.slice(start);
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (!turns.some(t => t.role === 'assistant')) { out.skipped++; continue; }
    if (!prev && stores.some(exists)) { out.keptAntigravityEdits++; log(`kept ${s.cliSessionId}: existing import has no matching export state`); continue; }
    const cwd = null; // like conversations started in the desktop app without a project: no folder, project "outside-of-project"
    const title = (s.title || turns[0].text.split('\n')[0]).slice(0, 80);
    if (dryRun) { log(`would export ${s.cliSessionId} (${turns.length} turns) ${title}`); out.exported++; continue; }
    // The desktop app titles a conversation by its first message, so lead with the Claude title.
    turns[0] = { ...turns[0], text: `【${title}】\n${turns[0].text}` };
    const projectId = 'outside-of-project';
    for (const st of stores) {
      const tpl = tplOf(st); const convId = idOf(st);
      const built = buildConversation({ tpl, turns, convId, cwd, projectId, title, outFile: cf(st, convId) });
      for (const sub of ['.system_generated', '.user_uploaded', 'scratch']) mkdirSync(join(st.dir, 'brain', convId, sub), { recursive: true });
      if (basename(st.dir) === 'antigravity') { dropFromHubCache(st.dir, [convId]); deleteSummary(st.dir, convId); }
      else upsertSummary(st.dir, tpl, convId, built, cwd, projectId, title); // index row last: it only points at data that already exists
    }
    state[key] = { mtime: mt, size, sourceId: s.cliSessionId, ancestors,
      full: maxTurns === Infinity && maxMsgChars === Infinity && maxHistoryBytes === Infinity, turns: turns.length, nativeSteps: turns.length };
    log(`exported ${s.cliSessionId} (${turns.length} turns) ${title}`); out.exported++;
  }
  return out;
}
