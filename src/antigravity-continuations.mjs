import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findTranscript, readNativeText, stableUuid } from './antigravity.mjs';
import { appendLocked, claudeReverseRecords } from './antigravity-reverse.mjs';
import { desktopSessions } from './claude-sessions.mjs';
import { claudeForwardCursor, syncColdForward } from './antigravity-cold-forward.mjs';
import { appendCodexBatch, codexForwardDelta, codexIsClosed, codexRolloutId } from './codex-rollout.mjs';

export const continuationStateFile = home => join(home, 'agy-reverse-live.json');
export const codexStateFile = home => join(home, 'agy-codex-live.json');
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function continuationPrefix(rows, count) {
  const hash = createHash('sha256');
  for (const { index, type, role, text } of rows.slice(0, count)) {
    hash.update(JSON.stringify([index, type, role, text]) + '\n');
  }
  return hash.digest('hex');
}

export function initializeContinuations(cfg, store, env = process.env) {
  const file = continuationStateFile(cfg.home);
  if (existsSync(file)) return;
  const exportFile = join(cfg.home, 'agy-export.json');
  if (!existsSync(exportFile)) throw new Error('Run agy-export with Antigravity closed before starting synchronization.');
  const exports = JSON.parse(readFileSync(exportFile, 'utf8'));
  const conversations = {};
  for (const [key, previous] of Object.entries(exports)) {
    if (!uuid.test(previous.sourceId)) continue;
    const id = stableUuid('conv/' + key);
    const native = join(store, 'conversations', id + '.db');
    const claude = findTranscript(previous.sourceId, env);
    if (!claude || !existsSync(native)) continue;
    const stat = statSync(claude);
    if (stat.size !== previous.size || stat.mtimeMs !== previous.mtime) continue;
    const rows = readNativeText(native, { includeMetadata: true });
    if (!rows.length || rows.length !== previous.turns || rows.some(r => !r.completed || !r.text)) continue;
    conversations[id] = { claudeId: previous.sourceId, count: rows.length, prefix: continuationPrefix(rows, rows.length),
      forward: claudeForwardCursor(claude, previous.size) };
  }
  if (!Object.keys(conversations).length) throw new Error('No unchanged imports are ready to sync. Run agy-export before continuing either side.');
  try {
    writeFileSync(file, JSON.stringify({ version: 1, conversations }, null, 2) + '\n', { flag: 'wx', flush: true });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function archivedContinuation(store, id) {
  try {
    return /\barchived:\s*true\b/.test(readFileSync(join(store, 'annotations', id + '.pbtxt'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function pairCodexContinuation(cfg, store, id, rollout) {
  if (!uuid.test(id)) throw Error('Specify the existing Antigravity conversation UUID.');
  const claudeMapping = continuationStateFile(cfg.home);
  if (existsSync(claudeMapping) && JSON.parse(readFileSync(claudeMapping, 'utf8')).conversations[id]) {
    throw Error('Choose an Antigravity conversation without an existing Claude mapping.');
  }
  if (archivedContinuation(store, id)) throw Error('The Antigravity conversation is archived.');
  const path = realpathSync(rollout);
  const threadId = codexRolloutId(path);
  const forward = claudeForwardCursor(path, statSync(path).size);
  const rows = readNativeText(join(store, 'conversations', id + '.db'), { includeMetadata: true });
  if (!rows.length) throw Error('Start the Antigravity conversation before pairing it.');
  const index = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true, timeout: 2000 });
  try {
    const row = index.prepare('select step_count,status,not_fully_idle from conversation_summaries where conversation_id=?').get(id);
    if (row?.step_count !== rows.length || row.status !== 'CASCADE_RUN_STATUS_IDLE' || row.not_fully_idle) {
      throw Error('Wait for the Antigravity conversation to finish before pairing it.');
    }
  } finally { index.close(); }
  const state = { version: 1, conversations: { [id]: {
    codex: { path, threadId }, forward, count: rows.length, prefix: continuationPrefix(rows, rows.length),
  } } };
  writeFileSync(codexStateFile(cfg.home), JSON.stringify(state, null, 2) + '\n', { flag: 'wx', flush: true });
  return threadId;
}

export function newMessages(rows, from, carry) {
  const messages = [];
  let user;
  let answer;
  let followup = carry;
  let stoppedForQuota = carry;
  let count = from;
  let nextCarry = carry;
  function finish(end) {
    if ((!user && !followup) || !answer) return;
    if (user) messages.push(user);
    messages.push(answer);
    count = end;
    nextCarry = stoppedForQuota;
  }
  for (let i = from; i < rows.length; i++) {
    const row = rows[i];
    if (row.role === 'user') {
      finish(i);
      user = row.completed && row.text?.trim() && Number.isFinite(row.ts) ? row : undefined;
      answer = undefined;
      followup = false;
      stoppedForQuota = false;
    } else if (row.type === 17) {
      if (row.quota) stoppedForQuota = true;
      else answer = undefined;
    } else if ((user || followup) && row.role === 'assistant' && row.completed && row.text?.trim() && Number.isFinite(row.ts)) {
      answer = answer ? { ...row, text: answer.text + '\n\n' + row.text } : row;
      stoppedForQuota = false;
    }
  }
  finish(rows.length);
  return { messages, count, nextCarry };
}

export function saveState(file, state) {
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function transcriptTail(file) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    const size = Number(stat.size);
    const length = Math.min(size, 16 * 1024 * 1024);
    const data = Buffer.alloc(length);
    if (!length || readSync(fd, data, 0, length, size - length) !== length || data.at(-1) !== 10) {
      throw new Error('Claude has an incomplete JSONL record.');
    }
    const offset = size === length ? 0 : data.indexOf(10) + 1;
    if (size > length && !offset) throw new Error('Claude JSONL tail could not be read.');
    const entries = data.subarray(offset).toString('utf8').trimEnd().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const head = entries.findLast(row => (row.type === 'user' || row.type === 'assistant') && !row.isSidechain && row.uuid && row.message);
    return { stat, entries, head };
  } finally {
    closeSync(fd);
  }
}

export function matchesClaudeHead(session, head, id, previousPrefix) {
  const index = JSON.parse(readFileSync(session.indexFile, 'utf8'));
  if (index.cliSessionId !== session.cliSessionId || index.isArchived) throw new Error('Claude moved or archived this conversation.');
  return head?.sessionId === session.cliSessionId && head.type === 'assistant' &&
    (index.lastAssistantUuid === head.uuid ||
      (head.multiClaude?.origin === id && head.multiClaude.batch === previousPrefix));
}

export function finishBatch(session, file, messages, id, batch, previousPrefix, tail) {
  const { head, stat, entries } = tail;
  const tag = batch.prefix;
  const applied = entries.filter(row => row.multiClaude?.origin === id && row.multiClaude?.batch === tag);
  if (applied.length) {
    if (applied.length !== messages.length || !messages.every((m, i) => {
      const row = applied[i];
      const previous = i ? applied[i - 1].uuid : batch.claudeBase;
      const value = m.role === 'user' ? row.message?.content : row.message?.content?.[0]?.text;
      return row.type === m.role && row.sessionId === session.cliSessionId &&
        row.parentUuid === previous && row.multiClaude.nativeIndex === m.index && value === m.text;
    })) throw new Error('The previous Claude append is incomplete.');
    return;
  }
  if (head?.uuid !== batch.claudeBase || !matchesClaudeHead(session, head, id, previousPrefix)) {
    throw new Error('Claude advanced before the pending append. Keeping both histories unchanged.');
  }
  const records = claudeReverseRecords(head, messages, id, tag);
  for (const row of records) row.multiClaude.batch = tag;
  const last = records.at(-1);
  if (Buffer.byteLength(JSON.stringify(records)) > 8 * 1024 * 1024) throw new Error('The pending Claude append is too large.');
  appendLocked(file, stat, records);
  const written = transcriptTail(file);
  if (written.head?.uuid !== last.uuid) throw new Error('Claude append did not pass read-back.');
  finishBatch(session, file, messages, id, batch, previousPrefix, written);
}

/** Each mapped conversation has its own sync position. Native writes wait for full exit. */
export function syncContinuations(cfg, store, log, notices, env = process.env,
  { codex = false, isCodexClosed = codexIsClosed, isAntigravityExited } = {}) {
  const stateFile = (codex ? codexStateFile : continuationStateFile)(cfg.home);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (state.version !== 1 || !state.conversations || !Object.entries(state.conversations).every(([id, record]) =>
    uuid.test(id) && (codex ? (uuid.test(record.codex?.threadId) && typeof record.codex?.path === 'string') : uuid.test(record.claudeId)) &&
    Number.isSafeInteger(record.count) && record.count > 0)) {
    throw new Error('Antigravity continuation mapping is invalid.');
  }
  if (codex && existsSync(continuationStateFile(cfg.home))) {
    const existing = JSON.parse(readFileSync(continuationStateFile(cfg.home), 'utf8')).conversations;
    if (Object.keys(state.conversations).some(id => existing[id])) {
      throw Error('An Antigravity conversation is mapped to both Claude and Codex.');
    }
  }
  const db = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true, timeout: 2000 });
  let sessions;
  const getSessions = () => sessions ??= desktopSessions(cfg);
  const save = () => saveState(stateFile, state);
  const notice = (id, error) => {
    if (notices.get(id) === error.message) return;
    notices.set(id, error.message);
    log(`Deferred ${id}: ${error.message.split('\n')[0]}`);
  };
  try {
    const summary = db.prepare('select step_count,status,not_fully_idle from conversation_summaries where conversation_id=?');
    for (const [id, record] of Object.entries(state.conversations)) {
      const row = summary.get(id);
      if (record.forwardPending || !row || row.status !== 'CASCADE_RUN_STATUS_IDLE' || row.not_fully_idle || row.step_count === record.count) continue;
      try {
        if (archivedContinuation(store, id)) throw new Error('The mapped Antigravity conversation is archived.');
        const file = join(store, 'conversations', id + '.db');
        const rows = readNativeText(file, { includeMetadata: true });
        if (rows.length !== row.step_count) continue;
        if (rows.length < record.count || continuationPrefix(rows, record.count) !== record.prefix) {
          throw new Error('Antigravity history changed before the sync position.');
        }
        const end = record.pending?.count ?? rows.length;
        if (end > rows.length) throw new Error('The pending Antigravity turns were removed.');
        const { messages, count, nextCarry } = newMessages(rows.slice(0, end), record.count, record.carry);
        if (!messages.length) continue;
        const prefix = continuationPrefix(rows, count);
        if (record.pending && (record.pending.count !== count || record.pending.prefix !== prefix)) {
          throw new Error('The pending Antigravity batch changed.');
        }
        let name;
        if (codex) {
          const path = record.codex.path;
          if (!isCodexClosed()) throw Error('Waiting for Codex to exit before writing the rollout.');
          if (!record.pending) {
            codexForwardDelta(record, id);
            record.pending = { count, prefix, codexBase: claudeForwardCursor(path, statSync(path).size) };
            save();
          }
          appendCodexBatch(record, messages, id, record.pending, isCodexClosed);
          name = record.codex.threadId;
        } else {
          const session = getSessions().find(item => item.cliSessionId === record.claudeId);
          if (!session) throw new Error('Claude moved or archived the mapped conversation.');
          const destination = findTranscript(record.claudeId, env);
          if (!destination) throw new Error('The mapped Claude transcript is missing.');
          const tail = transcriptTail(destination);
          if (!record.pending) {
            if (!matchesClaudeHead(session, tail.head, id, record.prefix)) {
              throw new Error('Waiting for a complete Claude turn in the shared transcript.');
            }
            record.pending = { count, prefix, claudeBase: tail.head.uuid };
            save();
          }
          finishBatch(session, destination, messages, id, record.pending, record.prefix, tail);
          name = session.title;
        }
        Object.assign(record, { count, prefix });
        if (nextCarry) record.carry = true;
        else delete record.carry;
        delete record.pending;
        save();
        notices.delete(id);
        log(`Antigravity → ${codex ? 'Codex' : 'Claude'} synced ${name} (${messages.length} messages).`);
      } catch (error) {
        notice(id, error);
      }
    }
  } finally {
    db.close();
  }
  syncColdForward({ store, conversations: state.conversations, getSessions, save, fingerprint: continuationPrefix,
    isArchived: archivedContinuation, codexSource: codexForwardDelta, isExited: isAntigravityExited, log, notice, env });
}
