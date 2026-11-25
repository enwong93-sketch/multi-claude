import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendNativeTurns, defaultStores, dropFromHubCache, findTranscript, loadTemplate, projectNativeText, readNativeText, sqlTime, visibleClaudeRecord } from './antigravity.mjs';
import { decode, encode, setTimestamp, setVarint } from './pb.mjs';

const maxTranscriptDelta = 64 * 1024 * 1024;
const maxImportedText = 80 * 1024;
const maxNativeText = 650 * 1024;

function readBytes(fd, start, length) {
  const bytes = Buffer.alloc(length);
  if (readSync(fd, bytes, 0, length, start) !== length) throw Error('Claude transcript changed while being read.');
  return bytes;
}

function anchor(fd, size) {
  const length = Math.min(size, 1024);
  const bytes = readBytes(fd, size - length, length);
  if (bytes.at(-1) !== 10) throw Error('Claude has an incomplete JSONL record.');
  return { size, tail: createHash('sha256').update(bytes).digest('hex') };
}

export function claudeForwardCursor(file, size) {
  const fd = openSync(file, 'r');
  try {
    const current = fstatSync(fd).size;
    if (!Number.isSafeInteger(size) || size < 1 || size > current) throw Error('Invalid Claude sync position.');
    return anchor(fd, size);
  } finally { closeSync(fd); }
}

function appExited() {
  const script = `
    $ErrorActionPreference='Stop'
    $active = Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe' OR Name='language_server.exe'" |
      Where-Object { $_.Name -eq 'Antigravity.exe' -or !$_.ExecutablePath -or
        $_.ExecutablePath -match '[\\\\/]antigravity[\\\\/]resources[\\\\/]' }
    if (!$active) { 'exited' }
  `;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim() === 'exited';
  } catch { return false; }
}

function readDelta(file, session, cursor, id, through) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    const size = through ?? stat.size;
    if (cursor.size > size || size > stat.size || anchor(fd, cursor.size).tail !== cursor.tail) {
      throw Error('Claude history changed before the sync position.');
    }
    if (size - cursor.size > maxTranscriptDelta) throw Error('Claude delta exceeds the size limit for automatic import.');
    const next = anchor(fd, size);
    const turns = [];
    let head;
    for (const line of readBytes(fd, cursor.size, size - cursor.size).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.sessionId !== session.cliSessionId || row.isSidechain) continue;
      if (row.uuid && row.message && (row.type === 'user' || row.type === 'assistant')) head = row;
      if (row.multiClaude?.origin === id || row.isCompactSummary) continue;
      const turn = visibleClaudeRecord(row);
      if (!turn) continue;
      const last = turns.at(-1);
      if (last?.role === turn.role) {
        last.text += '\n\n' + turn.text;
        last.ts = Math.max(last.ts ?? 0, turn.ts ?? 0);
      } else turns.push(turn);
    }
    if (turns.length && !through) {
      const index = JSON.parse(readFileSync(session.indexFile, 'utf8'));
      if (index.cliSessionId !== session.cliSessionId || index.isArchived ||
          head?.type !== 'assistant' || index.lastAssistantUuid !== head.uuid ||
          turns.at(-1).role !== 'assistant') {
        throw Error('Waiting for a complete indexed Claude turn.');
      }
    }
    return { next, turns };
  } finally { closeSync(fd); }
}

function publishSummary(store, id, count, last, lastUser, requireExited) {
  const db = new DatabaseSync(join(store, 'conversation_summaries.db'), { timeout: 3000 });
  try {
    db.exec('begin immediate');
    const row = db.prepare('select raw_summary from conversation_summaries where conversation_id=?').get(id);
    if (!row?.raw_summary) throw Error('Antigravity conversation summary is missing.');
    const raw = decode(Buffer.from(row.raw_summary));
    setVarint(raw, [2], count);
    for (const [field, ms] of [[3, last.ts], [10, lastUser.ts]]) {
      setTimestamp(raw, [field], Math.floor(ms / 1000), (ms % 1000) * 1000000);
    }
    setVarint(raw, [11], lastUser.index);
    db.prepare(`update conversation_summaries set step_count=?,last_modified_time=?,last_user_input_time=?,
      last_user_input_step_index=?,raw_summary=? where conversation_id=?`).run(
      count, sqlTime(last.ts), sqlTime(lastUser.ts), lastUser.index, encode(raw), id);
    requireExited();
    db.exec('commit');
  } finally { db.close(); }
}

export function syncColdForward({ store, conversations, getSessions, save, fingerprint, log, notice, isArchived = () => false,
  env = process.env, isExited = appExited, templateStore, codexSource }) {
  const requireExited = () => {
    if (!isExited()) throw Error('Waiting for Antigravity to exit completely.');
  };
  const candidates = [];
  for (const [id, record] of Object.entries(conversations)) {
    if (!record.forward || record.pending) continue;
    const path = record.codex?.path ?? findTranscript(record.claudeId, env);
    if (path && (record.forwardPending || statSync(path).size !== record.forward.size)) {
      candidates.push({ id, record, path });
    }
  }
  if (!candidates.length || !isExited()) return;
  let tpl;
  for (const { id, record, path } of candidates) {
    try {
      const through = record.forwardPending?.source.size;
      const session = record.codex ?? getSessions().find(item => item.cliSessionId === record.claudeId);
      if (!session) throw Error('Claude changed the session mapping.');
      const { next, turns } = record.codex ? codexSource(record, id, through) : readDelta(path, session, record.forward, id, through);
      if (!turns.length && !record.forwardPending) {
        record.forward = next;
        save();
        continue;
      }
      if (isArchived(store, id)) throw Error('The mapped Antigravity conversation is archived.');
      const index = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true, timeout: 2000 });
      let row;
      try {
        row = index.prepare('select status,not_fully_idle from conversation_summaries where conversation_id=?').get(id);
      } finally { index.close(); }
      if (row?.status !== 'CASCADE_RUN_STATUS_IDLE' || row.not_fully_idle) {
        throw Error('Waiting for the matching Antigravity conversation to finish.');
      }
      const file = join(store, 'conversations', id + '.db');
      let rows = readNativeText(file, { includeMetadata: true });
      if (rows.length < record.count || fingerprint(rows, record.count) !== record.prefix) {
        throw Error('Antigravity history changed before the sync position.');
      }
      const pending = record.forwardPending;
      if (pending && next.tail !== pending.source.tail) throw Error('The pending Claude batch changed.');
      if (!pending && rows.length !== record.count) throw Error('Waiting for unsynced Antigravity turns to be written back.');
      const added = rows.slice(record.count);
      if (added.length && (added.length !== turns.length ||
          !added.every((row, i) => row.role === turns[i].role && row.text === turns[i].text))) {
        throw Error('Antigravity has different turns after the sync position.');
      }
      if (!added.length) {
        const size = seq => seq.reduce((n, row) => n + Buffer.byteLength(row.text ?? ''), 0);
        if (size(turns) > maxImportedText || size(rows) + size(turns) > maxNativeText) {
          throw Error('The Claude delta exceeds the Antigravity import budget.');
        }
        if (!turns.length) throw Error('The pending Claude batch is missing.');
        const existing = projectNativeText(rows);
        tpl ??= loadTemplate(templateStore ?? defaultStores(env).find(item => item.dir === store)?.templateDir ?? store);
        requireExited();
        record.forwardPending = { source: next };
        save();
        appendNativeTurns(file, id, tpl, { turns: existing.length }, [...existing, ...turns], requireExited);
        rows = readNativeText(file, { includeMetadata: true });
        if (rows.length !== record.count + turns.length ||
            !turns.every((turn, i) => rows[record.count+i]?.role === turn.role && rows[record.count+i]?.text === turn.text)) {
          throw Error('Antigravity append did not pass read-back.');
        }
      }
      requireExited();
      dropFromHubCache(store, [id], requireExited);
      publishSummary(store, id, rows.length, rows.at(-1), rows.findLast(row => row.role === 'user'), requireExited);
      record.count = rows.length;
      record.prefix = fingerprint(rows, rows.length);
      record.forward = next;
      delete record.forwardPending;
      save();
      log(`${record.codex ? 'Codex' : 'Claude'} → Antigravity synced ${session.title ?? session.threadId} (${turns.length} messages) while Antigravity was closed.`);
    } catch (error) {
      notice(id, error);
    }
  }
}
