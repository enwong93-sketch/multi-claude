import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendNativeTurns, defaultStores, dropFromHubCache, findTranscript, loadTemplate, projectNativeText, readNativeText, stableUuid } from './antigravity.mjs';
import { appExited, claudeForwardCursor, publishSummary, readClaudeDelta } from './antigravity-cold-forward.mjs';
import { archivedContinuation, codexStateFile, continuationPrefix, continuationStateFile, finishBatch, matchesClaudeHead, newMessages, saveState, transcriptTail } from './antigravity-continuations.mjs';
import { appendCodexBatch, codexForwardDelta, codexIsClosed, codexRolloutId } from './codex-rollout.mjs';
import { desktopSessions } from './claude-sessions.mjs';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const statePath = home => join(home, 'conversation-groups.json');

function loadGroups(file) {
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, groups: [] };
  if (state.version !== 1 || !Array.isArray(state.groups)) throw Error('Invalid conversation group configuration.');
  return state;
}

function withGroupLock(file, run) {
  const lock = file + '.lock';
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error('The conversation group is locked.');
    try { process.kill(pid, 0); } catch (check) {
      if (check.code !== 'ESRCH') throw check;
      rmSync(lock, { force: true });
      fd = openSync(lock, 'wx');
    }
    if (fd === undefined) throw Error('The conversation group is locked.');
  }
  try {
    writeFileSync(fd, String(process.pid));
    return run();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

function summary(store, id) {
  const db = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true, timeout: 2000 });
  try {
    const row = db.prepare('select title,step_count,status,not_fully_idle from conversation_summaries where conversation_id=?').get(id);
    if (!row || row.status !== 'CASCADE_RUN_STATUS_IDLE' || row.not_fully_idle) {
      throw Error('Waiting for the paired Antigravity conversation to finish.');
    }
    return row;
  } finally { db.close(); }
}

export function createSyncGroup(cfg, store, name, selected, env = process.env) {
  if (!/^[\w-]{1,40}$/.test(name ?? '')) throw Error('Choose a group name using letters, numbers, hyphens or underscores.');
  const file = statePath(cfg.home);
  return withGroupLock(file, () => {
    const state = loadGroups(file);
    const previous = state.groups.find(group => group.name === name);
    if (previous?.pending) throw Error('Finish the pending group transfer before adding a platform.');
    const members = { ...previous?.members };
    if ((selected.claude && members.claude && members.claude.id !== selected.claude) ||
        (selected.antigravity && members.antigravity && members.antigravity.id !== selected.antigravity) ||
        (selected.codex && members.codex && members.codex.path !== realpathSync(selected.codex))) {
      throw Error('This group already has a different conversation on that platform.');
    }
    if (selected.claude && !members.claude) {
      const id = selected.claude;
      if (!uuid.test(id) || !desktopSessions(cfg).some(s => s.cliSessionId === id)) throw Error('Choose an existing local Claude conversation ID.');
      const path = findTranscript(id, env);
      if (!path) throw Error('The Claude transcript is unavailable.');
      members.claude = { id, cursor: claudeForwardCursor(path, statSync(path).size) };
    }
    if (selected.codex && !members.codex) {
      const path = realpathSync(selected.codex);
      members.codex = { id: codexRolloutId(path), path, cursor: claudeForwardCursor(path, statSync(path).size) };
    }
    if (selected.antigravity && !members.antigravity) {
      const id = selected.antigravity;
      if (!uuid.test(id) || archivedContinuation(store, id)) throw Error('Choose an active Antigravity conversation ID.');
      const row = summary(store, id);
      const rows = readNativeText(join(store, 'conversations', id + '.db'), { includeMetadata: true });
      if (rows.length !== row.step_count) throw Error('The Antigravity conversation is still saving.');
      members.antigravity = { id, cursor: { count: rows.length, prefix: continuationPrefix(rows, rows.length) } };
    }
    if (Object.keys(members).length < 2) throw Error('Select at least two platforms.');
    const claudeMap = continuationStateFile(cfg.home);
    const codexMap = codexStateFile(cfg.home);
    for (const path of [claudeMap, codexMap]) {
      if (!existsSync(path)) continue;
      const pairs = JSON.parse(readFileSync(path, 'utf8')).conversations;
      if (Object.entries(pairs).some(([id, pair]) => id === members.antigravity?.id || pair.claudeId && pair.claudeId === members.claude?.id ||
          pair.codex?.threadId && pair.codex.threadId === members.codex?.id)) {
        throw Error('A selected conversation already belongs to an older sync pairing.');
      }
    }
    for (const [platform, member] of Object.entries(members)) {
      if (state.groups.some(group => group !== previous && group.members[platform]?.id === member.id)) {
        throw Error('A selected conversation already belongs to another group.');
      }
    }
    if (previous) previous.members = members;
    else state.groups.push({ name, id: stableUuid('conversation-group/' + name + '/' + Object.values(members).map(m => m.id).join('/')), members });
    saveState(file, state);
    return Object.keys(members);
  });
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function nativeFile(store, member) {
  return join(store, 'conversations', member.id + '.db');
}

function nativeRows(store, member) {
  if (archivedContinuation(store, member.id)) throw Error('The paired Antigravity conversation is archived.');
  const rows = readNativeText(nativeFile(store, member), { includeMetadata: true });
  const { count, prefix } = member.cursor;
  if (rows.length < count || continuationPrefix(rows, count) !== prefix) {
    throw Error('Antigravity history changed before the group sync position.');
  }
  return rows;
}

function claudeTarget(ctx, member) {
  ctx.sessions ??= desktopSessions(ctx.cfg);
  const session = ctx.sessions.find(s => s.cliSessionId === member.id);
  const path = findTranscript(member.id, ctx.env);
  if (!session || !path) throw Error('The paired Claude conversation is unavailable.');
  return { session, path };
}

function readSource(ctx, group, platform, through) {
  const member = group.members[platform];
  if (platform === 'codex') {
    return codexForwardDelta({ codex: { path: member.path, threadId: member.id }, forward: member.cursor }, group.id, through?.size);
  }
  if (platform === 'claude') {
    const { session, path } = claudeTarget(ctx, member);
    return readClaudeDelta(path, session, member.cursor, group.id, through?.size);
  }
  const check = summary(ctx.store, member.id);
  const rows = nativeRows(ctx.store, member);
  if (rows.length !== check.step_count) throw Error('The Antigravity conversation is still saving.');
  const selected = rows.slice(0, through?.count ?? rows.length);
  const parsed = newMessages(selected, member.cursor.count, member.cursor.carry);
  if (!parsed.messages.length && selected.some((r, i) => i >= member.cursor.count && r.role === 'user')) {
    throw Error('Waiting for a completed Antigravity reply.');
  }
  return { next: { count: parsed.count, prefix: continuationPrefix(selected, parsed.count), carry: !!parsed.nextCarry },
    turns: parsed.messages.map(({ role, text, ts }) => ({ role, text, ts })) };
}

function coldWrite(ctx, member, turns) {
  const requireExited = () => {
    if (!ctx.isAntigravityExited()) throw Error('Waiting for Antigravity to exit.');
  };
  requireExited();
  summary(ctx.store, member.id);
  const file = nativeFile(ctx.store, member);
  let rows = nativeRows(ctx.store, member);
  const { count } = member.cursor;
  if (Buffer.byteLength(turns.map(turn => turn.text).join('')) > 80 * 1024) throw Error('Group batch exceeds the Antigravity import budget.');
  if (rows.length === count) {
    if (Buffer.byteLength([...rows, ...turns].map(turn => turn.text ?? '').join('')) > 650 * 1024) {
      throw Error('Antigravity history exceeds the group import budget.');
    }
    ctx.tpl ??= loadTemplate(defaultStores(ctx.env).find(entry => entry.dir === ctx.store)?.templateDir ?? ctx.store);
    const existing = projectNativeText(rows);
    appendNativeTurns(file, member.id, ctx.tpl, { turns: existing.length }, [...existing, ...turns], requireExited);
    rows = nativeRows(ctx.store, member);
  }
  if (rows.length !== count + turns.length ||
      turns.some((turn, i) => turn.role !== rows[count+i].role || turn.text !== rows[count+i].text)) {
    throw Error('Antigravity advanced before the pending group append.');
  }
  requireExited();
  dropFromHubCache(ctx.store, [member.id], requireExited);
  publishSummary(ctx.store, member.id, rows.length, rows.at(-1), rows.findLast(row => row.role === 'user'), requireExited);
  return { count: rows.length, prefix: continuationPrefix(rows, rows.length) };
}

function deliver(ctx, group, platform, messages, save) {
  const member = group.members[platform];
  const batch = group.pending;
  if (platform === 'antigravity') return coldWrite(ctx, member, messages);
  if (platform === 'codex') {
    const target = { codex: { path: member.path, threadId: member.id } };
    appendCodexBatch(target, messages, group.id, { prefix: batch.key, codexBase: member.cursor }, ctx.isCodexClosed);
    const observed = codexForwardDelta({ ...target, forward: member.cursor }, group.id);
    if (observed.turns.length) throw Error('Codex advanced during the pending group append.');
    return observed.next;
  }
  const { session, path } = claudeTarget(ctx, member);
  const tail = transcriptTail(path);
  if (!batch.claudeBase) {
    if (tail.stat.size !== BigInt(member.cursor.size) || !matchesClaudeHead(session, tail.head, group.id, member.lastBatch)) {
      throw Error('Claude advanced before the pending group append.');
    }
    batch.claudeBase = tail.head.uuid;
    save();
  }
  finishBatch(session, path, messages, group.id, { prefix: batch.key, claudeBase: batch.claudeBase }, member.lastBatch, tail);
  const observed = readClaudeDelta(path, session, member.cursor, group.id);
  if (observed.turns.length) throw Error('Claude advanced during the pending group append.');
  return observed.next;
}

function syncGroup(ctx, group, save, log, notice) {
  const platforms = Object.keys(group.members);
  if (!group.pending) {
    const ready = [];
    for (const platform of platforms) {
      const delta = readSource(ctx, group, platform);
      if (delta.turns.length) ready.push({ platform, ...delta });
      else if (digest(group.members[platform].cursor) !== digest(delta.next)) {
        group.members[platform].cursor = delta.next;
        save();
      }
    }
    if (ready.length > 1) throw Error('Multiple platforms advanced the same group. Both histories are retained.');
    if (!ready.length) return;
    const [{ platform, next, turns }] = ready;
    group.pending = { from: platform, next, key: digest([platform, next, turns]), delivered: [] };
    save();
  }
  const batch = group.pending;
  const { turns, next } = readSource(ctx, group, batch.from, batch.next);
  if (digest([batch.from, next, turns]) !== batch.key) throw Error('The pending group source changed.');
  const messages = turns.map((turn, index) => ({ ...turn, index }));
  for (const platform of platforms) {
    if (platform === batch.from || batch.delivered.includes(platform)) continue;
    try {
      const member = group.members[platform];
      member.cursor = deliver(ctx, group, platform, messages, save);
      member.lastBatch = batch.key;
      batch.delivered.push(platform);
      save();
      log(`${group.name}: ${batch.from} → ${platform} (${messages.length} messages).`);
    } catch (error) { notice(group.name + '/' + platform, error); }
  }
  if (batch.delivered.length === platforms.length - 1) {
    group.members[batch.from].cursor = batch.next;
    delete group.pending;
    save();
  }
}

export function syncConversationGroups(cfg, store, log, notice, env = process.env,
  { isAntigravityExited = appExited, isCodexClosed = codexIsClosed } = {}) {
  const file = statePath(cfg.home);
  if (!existsSync(file)) return;
  withGroupLock(file, () => {
    const state = loadGroups(file);
    const ctx = { cfg, store, env, isAntigravityExited, isCodexClosed };
    const save = () => saveState(file, state);
    for (const group of state.groups) {
      try { syncGroup(ctx, group, save, log, notice); }
      catch (error) { notice(group.name, error); }
    }
  });
}
