import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { stableUuid } from './antigravity.mjs';
import { appendLocked } from './antigravity-reverse.mjs';
import { claudeForwardCursor } from './antigravity-cold-forward.mjs';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const maxRead = 32 * 1024 * 1024;

function read(file, start = 0, through) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    const end = through ?? Number(stat.size);
    if (start > end || end > Number(stat.size) || end - start > maxRead) throw Error('Codex rollout delta is outside the sync budget.');
    const bytes = Buffer.alloc(end - start);
    if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length ||
        (bytes.length && bytes.at(-1) !== 10)) throw Error('Codex rollout has an incomplete JSONL record.');
    return { stat, rows: bytes.toString('utf8').split('\n').filter(x => x.trim()).map(line => JSON.parse(line)) };
  } finally { closeSync(fd); }
}

export function codexRolloutId(file) {
  const match = /^rollout-.*-([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\.jsonl$/i.exec(basename(file));
  if (!match) throw Error('Choose an existing Codex rollout JSONL file.');
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(65536);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, n).indexOf(10);
    if (newline < 0) throw Error('The Codex rollout header is missing.');
    const row = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
    if (row.type !== 'session_meta' || row.payload?.id !== match[1] || !uuid.test(match[1])) {
      throw Error('The Codex rollout does not match its thread ID.');
    }
    return match[1];
  } finally { closeSync(fd); }
}

export function codexIsClosed() {
  try {
    const result = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq codex.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return !/^"codex\.exe"/im.test(result);
  } catch { return false; }
}

export function codexRows(messages, id, batch) {
  const records = [];
  let group = [];
  function flush() {
    if (!group.length) return;
    const turnId = stableUuid('codex-turn/' + id + '/' + batch + '/' + group[0].index);
    const row = (ts, type, payload) => records.push({
      timestamp: new Date(ts).toISOString(), type, payload, multiClaude: { origin: id, batch },
    });
    const event = (ts, type, payload) => row(ts, 'event_msg', { type, ...payload });
    event(group[0].ts, 'task_started', { turn_id: turnId });
    for (const { role, text, ts, index } of group) {
      const assistant = role === 'assistant';
      row(ts, 'response_item', { type: 'message', id: 'msg_' + stableUuid(turnId + '/' + index), role,
        ...(assistant ? { phase: 'final_answer' } : {}),
        content: [{ type: assistant ? 'output_text' : 'input_text', text }] });
      if (assistant) event(ts, 'agent_message', { message: text, phase: 'final_answer' });
      else event(ts, 'user_message', { message: text, images: [], local_images: [], text_elements: [] });
    }
    const last = group.at(-1);
    event(last.ts, 'task_complete', { turn_id: turnId, last_agent_message: last.text });
    group = [];
  }
  for (const message of messages) {
    if (message.role === 'user') flush();
    group.push(message);
  }
  flush();
  return records;
}

export function appendCodexBatch(record, messages, id, batch, isClosed = codexIsClosed) {
  if (!isClosed()) throw Error('Waiting for Codex to exit before writing the rollout.');
  if (codexRolloutId(record.codex.path) !== record.codex.threadId) throw Error('Codex rollout identity changed.');
  if (claudeForwardCursor(record.codex.path, batch.codexBase.size).tail !== batch.codexBase.tail) {
    throw Error('Codex rollout changed before the pending append.');
  }
  const { stat, rows } = read(record.codex.path, batch.codexBase.size);
  const prepared = codexRows(messages, id, batch.prefix);
  const receipts = rows.filter(row => row.multiClaude?.origin === id && row.multiClaude?.batch === batch.prefix);
  if (receipts.length) {
    if (JSON.stringify(receipts) !== JSON.stringify(prepared)) throw Error('The prior Codex append is incomplete.');
    return;
  }
  if (rows.length) throw Error('Codex advanced before the pending append.');
  if (Buffer.byteLength(JSON.stringify(prepared)) > 8 * 1024 * 1024) throw Error('The Codex append exceeds the sync budget.');
  if (!isClosed()) throw Error('Codex opened before the rollout could be written.');
  appendLocked(record.codex.path, stat, prepared);
  const written = read(record.codex.path, batch.codexBase.size).rows;
  if (JSON.stringify(written) !== JSON.stringify(prepared)) throw Error('Codex rollout append did not pass read-back.');
}

export function codexDelta(file, start, id, through) {
  const { rows } = read(file, start, through);
  const turns = [];
  let turn = [];
  let waiting = false;
  for (const row of rows) {
    if (row.multiClaude?.origin === id) continue;
    const p = row.payload;
    if (row.type === 'event_msg') {
      if (p?.type === 'task_started') { waiting = true; turn = []; }
      if (p?.type === 'turn_aborted') { waiting = false; turn = []; }
      if (p?.type === 'task_complete') {
        if (turn.at(-1)?.role === 'assistant') turns.push(...turn);
        waiting = false; turn = [];
      }
      continue;
    }
    if (row.type !== 'response_item' || p?.type !== 'message' || !['user', 'assistant'].includes(p.role)) continue;
    const text = (p.content ?? []).filter(x => x.type === (p.role === 'user' ? 'input_text' : 'output_text'))
      .map(x => x.text).filter(x => typeof x === 'string').join('\n');
    if (!text.trim() || (p.role === 'user' && /^\s*(<environment_context>|# AGENTS\.md instructions\b)/.test(text))) continue;
    waiting = true;
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) throw Error('Invalid Codex message timestamp.');
    if (turn.at(-1)?.role === p.role) {
      turn.at(-1).text += '\n\n' + text;
      turn.at(-1).ts = ts;
    } else turn.push({ role: p.role, text, ts });
  }
  if (waiting) throw Error('Waiting for Codex to finish the current turn.');
  return turns;
}

export function codexForwardDelta(record, id, through) {
  const { path, threadId } = record.codex;
  if (codexRolloutId(path) !== threadId || claudeForwardCursor(path, record.forward.size).tail !== record.forward.tail) {
    throw Error('Codex history changed before the sync position.');
  }
  const fd = openSync(path, 'r');
  let size;
  try { size = through ?? Number(fstatSync(fd, { bigint: true }).size); } finally { closeSync(fd); }
  const next = claudeForwardCursor(path, size);
  return { next, turns: codexDelta(path, record.forward.size, id, size) };
}
