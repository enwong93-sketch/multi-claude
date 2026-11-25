import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { decode, encode, find, setText } from '../src/pb.mjs';
import { appendNativeTurns, buildConversation, claudeTurns, exportSessions, loadTemplate, projectNativeText, readNativeText, stableUuid, upsertSummary } from '../src/antigravity.mjs';
import { codexStateFile, continuationPrefix, continuationStateFile, initializeContinuations, pairCodexContinuation, syncContinuations } from '../src/antigravity-continuations.mjs';
import { codexDelta, codexRows } from '../src/codex-rollout.mjs';
import { createSyncGroup, syncConversationGroups } from '../src/conversation-groups.mjs';
import { claudeForwardCursor, syncColdForward } from '../src/antigravity-cold-forward.mjs';

const varint = n => { const o = []; do { let c = n & 127; n = Math.floor(n / 128); if (n) c |= 128; o.push(c); } while (n); return Buffer.from(o); };
const v = (f, n) => Buffer.concat([varint(f << 3), varint(n)]);
const l = (f, b) => { b = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([varint((f << 3) | 2), varint(b.length), b]); };
const stamp = (f, sec) => l(f, Buffer.concat([v(1, sec), v(2, 5)]));

test('protobuf codec round-trips and edits nested text', () => {
  const buf = Buffer.concat([v(1, 14), l(19, Buffer.concat([l(2, 'old'), l(3, l(1, 'old'))]))]);
  const t = decode(buf);
  assert.ok(encode(t).equals(buf));
  assert.ok(setText(t, [19, 3, 1], 'a much longer replacement text'));
  assert.equal(find(decode(encode(t)), [19, 3, 1]).v.toString(), 'a much longer replacement text');
});

test('claudeTurns keeps real text, drops reminders/tools/meta and merges same-role runs', () => {
  const L = o => JSON.stringify(o);
  const lines = [
    L({ type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { content: '<system-reminder>x</system-reminder>hello' } }),
    L({ type: 'assistant', timestamp: '2026-11-01T00:00:01Z', message: { content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'part one' }, { type: 'tool_use', name: 'Bash' }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'big output' }] } }),
    L({ type: 'assistant', timestamp: '2026-11-01T00:00:02Z', message: { content: [{ type: 'text', text: 'part two' }] } }),
    L({ type: 'user', isMeta: true, message: { content: 'meta' } }),
    L({ type: 'user', timestamp: '2026-11-01T00:00:03Z', message: { content: 'next' } }),
  ];
  assert.deepEqual(claudeTurns(lines).map(x => [x.role, x.text]), [['user', 'hello'], ['assistant', 'part one\n\npart two'], ['user', 'next']]);
  assert.equal(claudeTurns(lines)[1].ts, Date.parse('2026-11-01T00:00:02Z'));
});

test('claudeTurns drops task notifications and the attach marker', () => {
  const L = o => JSON.stringify(o);
  const t = claudeTurns([
    L({ type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' } }),
    L({ type: 'user', message: { content: '<!-- attach -->\nreal question' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }),
  ]);
  assert.deepEqual(t.map(x => [x.role, x.text]), [['user', 'real question'], ['assistant', 'answer']]);
});

test('stable ids are deterministic uuid v5-shaped', () => {
  assert.equal(stableUuid('a'), stableUuid('a')); assert.notEqual(stableUuid('a'), stableUuid('b'));
  assert.match(stableUuid('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

function fakeStore() {
  const store = mkdtempSync(join(tmpdir(), 'agy-')); mkdirSync(join(store, 'conversations'));
  const execOld = 'exec-old-uuid-000000000000000000';
  const userP = Buffer.concat([v(1, 14), l(5, Buffer.concat([stamp(1, 1790000000), l(12, execOld)])), l(19, Buffer.concat([l(2, 'tpl user'), l(3, l(1, 'tpl user'))]))]);
  const asstP = Buffer.concat([v(1, 15), l(5, Buffer.concat([stamp(1, 1790000001), l(12, execOld)])), l(20, Buffer.concat([l(1, 'tpl reply'), l(8, 'tpl reply'), l(14, Buffer.from([1, 2, 3, 4, 5]))]))]);
  const convId = 'aaaaaaaa-0000-4000-8000-000000000001', traj = 'bbbbbbbb-0000-4000-8000-000000000001';
  const db = new DatabaseSync(join(store, 'conversations', convId + '.db'));
  db.exec('create table steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, has_subtrajectory numeric not null default false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer not null default 0)');
  db.exec('create table trajectory_meta (trajectory_id text primary key, cascade_id text, trajectory_type integer, source integer)');
  db.exec('create table gen_metadata (idx integer primary key, data blob, size integer not null default 0)');
  db.exec('create table executor_metadata (idx integer primary key, data blob)');
  db.exec("create table trajectory_metadata_blob (id text primary key default 'main', data blob)");
  db.prepare('insert into steps (idx,step_type,status,step_payload) values (0,14,3,?),(1,15,3,?)').run(userP, asstP);
  db.prepare('insert into trajectory_meta values (?,?,4,17)').run(traj, convId);
  db.prepare('insert into gen_metadata values (0,?,3)').run(Buffer.from('gen'));
  db.prepare('insert into executor_metadata values (0,?)').run(l(9, execOld));
  db.prepare("insert into trajectory_metadata_blob values ('main',?)").run(Buffer.concat([l(1, 'file:///D:/Tpl'), l(3, 'run-old'), l(6, convId), l(18, 'default-cli-project')]));
  db.close();
  const sum = new DatabaseSync(join(store, 'conversation_summaries.db'));
  sum.exec("create table conversation_summaries (conversation_id text primary key, title text not null default '', preview text not null default '', step_count integer not null default 0, last_modified_time datetime not null, workspace_uris text not null, status text not null default '', source text not null default '', project_id text not null default '', agent_name text not null default '', parent_conversation_id text not null default '', nesting_depth integer not null default 0, battle_id text not null default '', winning_conversation_id text not null default '', not_fully_idle numeric not null default false, killed numeric not null default false, last_user_input_time datetime not null, last_user_input_step_index integer not null default -1, app_data_dir text not null default '', raw_summary blob, group_id text not null default '')");
  const raw = Buffer.concat([l(1, 'tpl'), v(2, 2), stamp(3, 1790000001), l(4, traj), stamp(7, 1790000000), stamp(10, 1790000000), l(15, l(1, 'tpl')), l(17, Buffer.concat([l(3, 'run-old'), l(6, convId), l(18, 'default-cli-project')]))]);
  sum.prepare('insert into conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,source,project_id,last_user_input_time,app_data_dir,raw_summary) values (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(convId, 'tpl', 'tpl', 2, '2026-10-01 00:00:00.0000000+00:00', '["file:///D:/Tpl"]', 'CASCADE_RUN_STATUS_IDLE', '', 'default-cli-project', '2026-10-01 00:00:00.0000000+00:00', 'fake', raw);
  sum.close();
  return store;
}

test('live native update keeps existing steps and rejects a different history', t => {
  const store = fakeStore();
  t.after(() => rmSync(store, { recursive: true, force: true }));
  const tpl = loadTemplate(store);
  const convId = stableUuid('test-live');
  const file = join(store, 'conversations', convId + '.db');
  const ts = Date.parse('2026-11-02T00:00:00Z');
  const original = [{ role: 'user', text: 'Question', ts }, { role: 'assistant', text: 'Part one', ts: ts + 1000 }];
  const next = [original[0], { ...original[1], text: 'Part one\n\nPart two', ts: ts + 2000 },
    { role: 'user', text: 'Followup', ts: ts + 3000 }];
  buildConversation({ tpl, convId, turns: original, title: 'Test', projectId: 'outside-of-project', outFile: file });
  const rows = () => {
    const d = new DatabaseSync(file, { readOnly: true });
    try { return d.prepare('select step_payload from steps order by idx').all().map(row => Buffer.from(row.step_payload)); }
    finally { d.close(); }
  };
  const before = rows();
  assert.deepEqual(readNativeText(file).map(({ role, text, ts, completed }) => ({ role, text, ts, completed })),
    original.map(turn => ({ ...turn, completed: true })));
  assert.equal(appendNativeTurns(file, convId, tpl, { turns: 2 }, next), true);
  const after = rows();
  assert.equal(after.length, 3);
  assert.deepEqual(after[0], before[0]);
  assert.equal(find(decode(after[1]), [20, 1]).v.toString(), next[1].text);
  assert.equal(find(decode(after[2]), [19, 2]).v.toString(), next[2].text);
  assert.equal(appendNativeTurns(file, convId, tpl, { turns: 2 }, next), false);
  assert.throws(() => appendNativeTurns(file, convId, tpl, { turns: 3 }, [
    { ...original[0], text: 'Different question' }, ...next.slice(1),
  ]), /diverged/);
  assert.deepEqual(rows(), after);
});

test('first desktop import establishes the shared transcript mapping', t => {
  const store = fakeStore();
  const home = mkdtempSync(join(tmpdir(), 'mc-setup-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
  const env = { USERPROFILE: home };
  const cliSessionId = stableUuid('setup-session');
  const project = join(home, '.claude', 'projects', 'fixture');
  mkdirSync(project, { recursive: true });
  const transcript = join(project, cliSessionId + '.jsonl');
  writeFileSync(transcript, [{ type: 'user', message: { content: 'question' } },
    { type: 'assistant', message: { content: 'answer' } }].map(row => JSON.stringify(row) + '\n').join(''));
  const state = {};
  exportSessions({ stores: [store], sessions: [{ cliSessionId }], state, env });
  assert.equal(state[cliSessionId].size, statSync(transcript).size);
  writeFileSync(join(home, 'agy-export.json'), JSON.stringify(state));
  initializeContinuations({ home }, store, env);
  const mapping = continuationStateFile(home);
  const written = readFileSync(mapping, 'utf8');
  const imported = JSON.parse(written).conversations[stableUuid('conv/' + cliSessionId)];
  assert.equal(imported.claudeId, cliSessionId);
  assert.equal(imported.count, 2);
  assert.equal(imported.forward.size, statSync(transcript).size);
  initializeContinuations({ home }, store, env);
  assert.equal(readFileSync(mapping, 'utf8'), written);
});

test('opt-in Codex pair syncs both ways and skips its own imported items', { skip: process.platform !== 'win32' }, t => {
  const store = fakeStore();
  const home = mkdtempSync(join(tmpdir(), 'mc-codex-fixture-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
  const config = { home };
  const id = stableUuid('codex-native');
  const codexId = stableUuid('codex-fixture');
  const rollout = join(home, 'rollout-fixture-' + codexId + '.jsonl');
  const ts = Date.parse('2026-11-03T00:00:00Z');
  const turn = (role, text, index) => ({ role, text, index, ts: ts + (index + 1) * 1000 });
  const write = (file, rows) => appendFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''));
  write(rollout, [{ timestamp: new Date(ts).toISOString(), type: 'session_meta', payload: { id: codexId } }]);
  const cursor = statSync(rollout).size;
  const tpl = loadTemplate(store);
  const native = join(store, 'conversations', id + '.db');
  const start = [turn('user', 'Original Antigravity prompt', 0), turn('assistant', 'Original Antigravity reply', 1)];
  const built = buildConversation({ tpl, turns: start, convId: id, outFile: native, title: 'Codex fixture', projectId: 'outside-of-project' });
  upsertSummary(store, tpl, id, built, null, 'outside-of-project', 'Codex fixture');
  const setSummary = count => {
    const db = new DatabaseSync(join(store, 'conversation_summaries.db'));
    db.prepare('update conversation_summaries set step_count=?,status=? where conversation_id=?')
      .run(count, 'CASCADE_RUN_STATUS_IDLE', id);
    db.close();
  };
  setSummary(2);
  assert.equal(pairCodexContinuation(config, store, id, rollout), codexId);
  assert.equal(JSON.parse(readFileSync(codexStateFile(home), 'utf8')).conversations[id].forward.size, cursor);
  assert.throws(() => pairCodexContinuation(config, store, id, rollout), /EEXIST/);
  const own = codexRows([turn('user', 'Codex asks', 2), turn('assistant', 'Codex answers', 3)], 'fixture', 'fixture');
  own.forEach(row => delete row.multiClaude);
  write(rollout, own.slice(0, -1));
  assert.throws(() => codexDelta(rollout, cursor, id), /finish the current turn/);
  write(rollout, own.slice(-1));
  const log = [];
  const sync = (isCodexClosed, isAntigravityExited) => syncContinuations(config, store, value => log.push(value),
    new Map(), { USERPROFILE: home }, { codex: true, isCodexClosed: () => isCodexClosed, isAntigravityExited: () => isAntigravityExited });
  sync(true, false);
  assert.equal(readNativeText(native).length, 2);
  sync(true, true);
  const imported = projectNativeText(readNativeText(native));
  assert.deepEqual(imported.slice(2).map(x => x.text), ['Codex asks', 'Codex answers'], log.join('\n'));
  const fromAgy = [turn('user', 'Antigravity asks', 4), turn('assistant', 'Antigravity answers', 5)];
  appendNativeTurns(native, id, tpl, { turns: 4 }, [...imported, ...fromAgy]);
  setSummary(6);
  const before = readFileSync(rollout, 'utf8');
  sync(false, true);
  assert.equal(readFileSync(rollout, 'utf8'), before);
  sync(true, true);
  const after = readFileSync(rollout, 'utf8');
  assert.ok(after.includes('Antigravity answers'), log.join('\n'));
  assert.equal(readNativeText(native).length, 6);
  sync(true, true);
  assert.equal(readFileSync(rollout, 'utf8'), after);
});

test('platform groups support every pair and adding a third peer without replay or duplicate delivery', { skip: process.platform !== 'win32' }, t => {
  const store = fakeStore();
  const root = mkdtempSync(join(tmpdir(), 'mc-platform-groups-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
  const ts = Date.parse('2026-11-04T00:00:00Z');
  const turn = (role, text, index) => ({ role, text, index, ts: ts + (index + 1) * 1000 });
  const append = (file, rows) => appendFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  for (const [initial, addThird] of [[['claude', 'codex'], true], [['claude', 'codex'], false],
    [['antigravity', 'codex'], false], [['antigravity', 'claude'], false]]) {
    const name = initial.join('-') + (addThird ? '-with-third' : '');
    const home = join(root, name);
    const project = join(home, '.claude', 'projects', 'fixture');
    const indexes = join(home, 'claude-code-sessions', 'account', 'org');
    mkdirSync(project, { recursive: true });
    mkdirSync(indexes, { recursive: true });
    const cfg = { home, primary: { name: 'A', userData: home }, runtimes: [] };
    const env = { USERPROFILE: home };
    const claude = stableUuid(name + '/claude'), codex = stableUuid(name + '/codex'), agy = stableUuid(name + '/agy');
    const transcript = join(project, claude + '.jsonl'), index = join(indexes, 'local_' + claude + '.json');
    const start = { type: 'assistant', uuid: stableUuid(name + '/base'), sessionId: claude,
      cwd: home, version: '2.1.330', timestamp: new Date(ts).toISOString(),
      message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Claude baseline' }] } };
    append(transcript, [start]);
    const updateIndex = answer => writeFileSync(index, JSON.stringify({ cliSessionId: claude, lastAssistantUuid: answer.uuid }));
    updateIndex(start);
    const rollout = join(home, 'rollout-fixture-' + codex + '.jsonl');
    append(rollout, [{ timestamp: new Date(ts).toISOString(), type: 'session_meta', payload: { id: codex } }]);
    const tpl = loadTemplate(store), native = join(store, 'conversations', agy + '.db');
    const turns = [turn('user', 'Antigravity baseline', 0), turn('assistant', 'Baseline answer', 1)];
    const built = buildConversation({ tpl, turns, convId: agy, outFile: native, title: name, projectId: 'outside-of-project' });
    upsertSummary(store, tpl, agy, built, null, 'outside-of-project', name);
    const setSummary = count => {
      const db = new DatabaseSync(join(store, 'conversation_summaries.db'));
      db.prepare('update conversation_summaries set step_count=?,status=? where conversation_id=?')
        .run(count, 'CASCADE_RUN_STATUS_IDLE', agy);
      db.close();
    };
    setSummary(2);
    const selected = { claude, codex: rollout, antigravity: agy };
    const flags = Object.fromEntries(initial.map(platform => [platform, selected[platform]]));
    assert.deepEqual(new Set(createSyncGroup(cfg, store, name, flags, env)), new Set(initial));
    if (addThird) assert.equal(createSyncGroup(cfg, store, name, { antigravity: agy }, env).length, 3);
    const issues = [], log = [];
    const sync = (closed = true) => syncConversationGroups(cfg, store, msg => log.push(msg),
      (where, error) => issues.push(where + ': ' + error.message), env,
      { isAntigravityExited: () => closed, isCodexClosed: () => closed });
    const source = initial.includes('codex') ? 'codex' : 'claude';
    if (source === 'codex') {
      const nativeCodex = codexRows([turn('user', 'Group asks', 2), turn('assistant', 'Group answers', 3)], 'fixture', 'fixture');
      nativeCodex.forEach(row => delete row.multiClaude);
      append(rollout, nativeCodex);
    } else {
      const question = { ...start, type: 'user', uuid: stableUuid(name + '/q'), parentUuid: start.uuid,
        message: { role: 'user', content: 'Group asks' } };
      const answer = { ...start, uuid: stableUuid(name + '/a'), parentUuid: question.uuid,
        message: { ...start.message, content: [{ type: 'text', text: 'Group answers' }] } };
      append(transcript, [question, answer]);
      updateIndex(answer);
    }
    sync(false);
    assert.equal(readNativeText(native).length, 2);
    if (source === 'codex' && initial.includes('claude')) assert.ok(readFileSync(transcript, 'utf8').includes('Group answers'), issues.join('\n'));
    sync(true);
    const expectsAntigravity = addThird || initial.includes('antigravity');
    assert.deepEqual(readNativeText(native).slice(2).map(row => row.text),
      expectsAntigravity ? ['Group asks', 'Group answers'] : [], issues.join('\n'));
    if (addThird) {
      const history = projectNativeText(readNativeText(native));
      appendNativeTurns(native, agy, tpl, { turns: history.length }, [...history,
        turn('user', 'Third platform asks', 4), turn('assistant', 'Third platform answers', 5)]);
      setSummary(6);
      sync(true);
      assert.ok(readFileSync(transcript, 'utf8').includes('Third platform answers'), issues.join('\n'));
      assert.ok(readFileSync(rollout, 'utf8').includes('Third platform answers'), issues.join('\n'));
    }
    const sizes = [statSync(transcript).size, statSync(rollout).size, readNativeText(native).length];
    sync();
    assert.deepEqual([statSync(transcript).size, statSync(rollout).size, readNativeText(native).length], sizes);
  }
});

test('Shared JSONL continuation appends the new completed turn without replaying the shortened history', { skip: process.platform !== 'win32' }, t => {
  const home = mkdtempSync(join(tmpdir(), 'mc-continuation-'));
  const store = fakeStore();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
  const cfg = { home, primary: { name: 'A', userData: home }, runtimes: [] };
  const env = { USERPROFILE: home };
  const cliSessionId = stableUuid('continuation-claude');
  const convId = stableUuid('continuation-native');
  const project = join(home, '.claude', 'projects', 'fixture');
  const sessions = join(home, 'claude-code-sessions', 'account', 'org');
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(store, 'annotations'));
  const transcript = join(project, cliSessionId + '.jsonl');
  const index = join(sessions, 'local_' + cliSessionId + '.json');
  const base = stableUuid('continuation-head');
  const ts = Date.parse('2026-11-02T00:00:00Z');
  const savedHead = { type: 'assistant', uuid: base, sessionId: cliSessionId, cwd: home, version: '2.1.330',
    message: { model: 'fixture', role: 'assistant', content: [{ type: 'text', text: 'Unrelated complete Claude history' }] },
    timestamp: new Date(ts).toISOString() };
  writeFileSync(transcript, JSON.stringify(savedHead) + '\n');
  const initialIndex = { cliSessionId, lastAssistantUuid: base, lastActivityAt: ts, completedTurns: 10, title: 'Fixture' };
  writeFileSync(index, JSON.stringify(initialIndex));
  writeFileSync(join(store, 'annotations', convId + '.pbtxt'), 'title:"Fixture"');
  const tpl = loadTemplate(store);
  const nativeFile = join(store, 'conversations', convId + '.db');
  const turns = [
    ['user', 'Already present in short history'], ['assistant', 'Baseline'],
    ['user', 'Failed Antigravity prompt'], ['assistant', 'Discarded after error'],
    ['user', 'New Antigravity prompt'], ['assistant', 'New Antigravity reply'],
  ].map(([role, text], i) => ({ role, text, ts: ts + 1000 * (i + 1) }));
  const built = buildConversation({ tpl, turns, convId, outFile: nativeFile, title: 'Fixture', projectId: 'outside-of-project' });
  upsertSummary(store, tpl, convId, built, null, 'outside-of-project', 'Fixture');
  const native = new DatabaseSync(nativeFile);
  native.prepare('update steps set idx=idx+10 where idx>=4').run();
  native.prepare('insert into steps (idx,step_type,status,step_payload) values (4,17,3,?)').run(Buffer.from([8, 17]));
  native.close();
  const summaries = new DatabaseSync(join(store, 'conversation_summaries.db'));
  summaries.prepare('update conversation_summaries set status=?,step_count=7 where conversation_id=?').run('CASCADE_RUN_STATUS_IDLE', convId);
  summaries.close();
  const rows = readNativeText(nativeFile, { includeMetadata: true });
  const checkpoint = { claudeId: cliSessionId, count: 2, prefix: continuationPrefix(rows, 2) };
  const save = record => writeFileSync(continuationStateFile(home), JSON.stringify({ version: 1, conversations: { [convId]: record } }));
  save(checkpoint);
  const log = [];
  const sync = () => syncContinuations(cfg, store, message => log.push(message), new Map(), env);
  sync();
  const written = readFileSync(transcript, 'utf8');
  const [original, question, answer] = written.trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(original, savedHead);
  assert.equal(question.message.content, 'New Antigravity prompt', log.join('\n'));
  assert.equal(answer.message.content[0].text, 'New Antigravity reply');
  assert.equal(question.parentUuid, base);
  assert.equal(answer.parentUuid, question.uuid);
  assert.deepEqual(JSON.parse(readFileSync(index, 'utf8')), initialIndex);
  assert.deepEqual(readNativeText(nativeFile, { includeMetadata: true }), rows);
  assert.equal(JSON.parse(readFileSync(continuationStateFile(home))).conversations[convId].count, 7);
  // Recover after a JSONL append succeeded but the checkpoint write did not.
  save({ ...checkpoint, pending: { count: 7, prefix: continuationPrefix(rows, 7), claudeBase: base } });
  writeFileSync(index, JSON.stringify(initialIndex));
  sync();
  assert.equal(readFileSync(transcript, 'utf8'), written);
  assert.deepEqual(JSON.parse(readFileSync(index, 'utf8')), initialIndex);
  save({ ...checkpoint, prefix: 'changed' });
  sync();
  assert.match(log.at(-1), /Antigravity history changed/);
  assert.equal(readFileSync(transcript, 'utf8'), written);

  const clean = { claudeId: cliSessionId, count: 7, prefix: continuationPrefix(rows, 7),
    forward: claudeForwardCursor(transcript, Buffer.byteLength(written)) };
  const claudeQuestion = { ...savedHead, type: 'user', uuid: stableUuid('cold-user'), parentUuid: answer.uuid,
    message: { role: 'user', content: 'Next Claude question' } };
  const claudeAnswer = { ...savedHead, uuid: stableUuid('cold-answer'), parentUuid: claudeQuestion.uuid,
    message: { model: 'fixture', role: 'assistant', content: [{ type: 'text', text: 'Next Claude answer' }] } };
  appendFileSync(transcript, [claudeQuestion, claudeAnswer].map(x => JSON.stringify(x) + '\n').join(''));
  writeFileSync(index, JSON.stringify({ ...initialIndex, lastAssistantUuid: claudeAnswer.uuid }));
  const cold = isExited => syncColdForward({
    store, conversations: { [convId]: clean }, getSessions: () => [{ cliSessionId, indexFile: index, title: 'Fixture' }],
    save: () => save(clean), fingerprint: continuationPrefix, log: message => log.push(message),
    notice: (_, error) => log.push(error.message), env, templateStore: store, isExited,
  });
  cold(() => false);
  assert.deepEqual(readNativeText(nativeFile, { includeMetadata: true }), rows);
  let checks = 0;
  cold(() => ++checks < 3);
  assert.deepEqual(readNativeText(nativeFile, { includeMetadata: true }), rows);
  assert.ok(clean.forwardPending);
  cold(() => true);
  const reopened = readNativeText(nativeFile, { includeMetadata: true });
  assert.deepEqual(reopened.slice(0, rows.length), rows);
  assert.deepEqual(reopened.slice(rows.length).map(row => row.text), ['Next Claude question', 'Next Claude answer'], log.join('\n'));
  assert.equal(clean.count, 9);
  assert.equal(clean.forwardPending, undefined);
  const indexed = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true });
  assert.equal(indexed.prepare('select step_count from conversation_summaries where conversation_id=?').get(convId).step_count, 9);
  indexed.close();
  cold(() => true);
  assert.deepEqual(readNativeText(nativeFile, { includeMetadata: true }), reopened);

  const lateAnswer = { ...claudeAnswer, uuid: stableUuid('cold-late-answer'), parentUuid: claudeAnswer.uuid,
    message: { ...claudeAnswer.message, content: [{ type: 'text', text: 'Claude finished its previous answer' }] } };
  appendFileSync(transcript, JSON.stringify(lateAnswer) + '\n');
  writeFileSync(index, JSON.stringify({ ...initialIndex, lastAssistantUuid: lateAnswer.uuid }));
  cold(() => true);
  const updated = readNativeText(nativeFile, { includeMetadata: true });
  assert.deepEqual(updated.slice(0, reopened.length), reopened);
  assert.equal(updated.at(-1).text, 'Claude finished its previous answer');
  assert.equal(clean.count, 10);

  const secondary = join(home, 'secondary');
  const secondarySessions = join(secondary, 'claude-code-sessions', 'account', 'org');
  mkdirSync(secondarySessions, { recursive: true });
  const secondaryIndex = join(secondarySessions, 'local_' + cliSessionId + '.json');
  writeFileSync(secondaryIndex, readFileSync(index));
  cfg.runtimes.push({ name: 'B', profile: secondary });
  const beforeQuota = projectNativeText(updated);
  assert.equal(appendNativeTurns(nativeFile, convId, tpl, { turns: beforeQuota.length }, [...beforeQuota,
    { role: 'user', text: 'Resume analysis', ts: ts + 40000 },
    { role: 'assistant', text: 'Substantial progress before quota stop', ts: ts + 41000 }]), true);
  const draft = new DatabaseSync(nativeFile);
  const quotaIdx = draft.prepare('select max(idx)+1 idx from steps').get().idx;
  draft.prepare('insert into steps (idx,step_type,status,step_payload) values (?,17,3,?)').run(
    quotaIdx, l(24, l(3, l(2, 'RESOURCE_EXHAUSTED (code 429): quota reached.'))));
  draft.close();
  const quotaRows = readNativeText(nativeFile, { includeMetadata: true });
  const quotaSummary = new DatabaseSync(join(store, 'conversation_summaries.db'));
  quotaSummary.prepare('update conversation_summaries set step_count=? where conversation_id=?').run(quotaRows.length, convId);
  quotaSummary.close();
  sync();
  const afterQuota = JSON.parse(readFileSync(transcript, 'utf8').trimEnd().split('\n').at(-1));
  assert.equal(afterQuota.message.content[0].text, 'Substantial progress before quota stop', log.join('\n'));
  assert.equal(JSON.parse(readFileSync(index, 'utf8')).lastAssistantUuid, lateAnswer.uuid);
  assert.equal(JSON.parse(readFileSync(secondaryIndex, 'utf8')).lastAssistantUuid, lateAnswer.uuid);
  assert.equal(JSON.parse(readFileSync(continuationStateFile(home))).conversations[convId].carry, true);
  const beforeFollowup = projectNativeText(quotaRows);
  appendNativeTurns(nativeFile, convId, tpl, { turns: beforeFollowup.length }, [...beforeFollowup,
    { role: 'assistant', text: 'Continued after quota reset', ts: ts + 42000 }]);
  const followupSummary = new DatabaseSync(join(store, 'conversation_summaries.db'));
  followupSummary.prepare('update conversation_summaries set step_count=? where conversation_id=?').run(quotaRows.length+1, convId);
  followupSummary.close();
  sync();
  const afterFollowup = JSON.parse(readFileSync(transcript, 'utf8').trimEnd().split('\n').at(-1));
  assert.equal(afterFollowup.message.content[0].text, 'Continued after quota reset', log.join('\n'));
  assert.equal(afterFollowup.parentUuid, afterQuota.uuid);
  assert.equal(JSON.parse(readFileSync(index, 'utf8')).lastAssistantUuid, lateAnswer.uuid);
});

test('exportSessions writes an indexable conversation and never overwrites one continued in Antigravity', () => {
  const store = fakeStore(); const home = mkdtempSync(join(tmpdir(), 'home-')); const env = { USERPROFILE: home };
  const proj = join(home, '.claude', 'projects', 'p'); mkdirSync(proj, { recursive: true });
  const tr = join(proj, 'sess-1.jsonl');
  writeFileSync(tr, [
    { type: 'user', timestamp: '2026-11-02T00:00:00Z', message: { content: 'what is 2+2?' } },
    { type: 'assistant', timestamp: '2026-11-02T00:00:05Z', message: { content: [{ type: 'text', text: 'It is 4.' }] } },
  ].map(o => JSON.stringify(o)).join('\n'));
  const state = {}; const sess = [{ cliSessionId: 'sess-1', cwd: 'D:\\Proj', title: 'Math' }];
  assert.equal(exportSessions({ stores: [store], sessions: sess, state, env }).exported, 1);
  const convId = stableUuid('conv/sess-1');
  const d = new DatabaseSync(join(store, 'conversations', convId + '.db'), { readOnly: true });
  const steps = d.prepare('select * from steps order by idx').all();
  assert.equal(steps.length, 2);
  assert.equal(find(decode(Buffer.from(steps[0].step_payload)), [19, 3, 1]).v.toString(), '【Math】\nwhat is 2+2?');
  assert.equal(find(decode(Buffer.from(steps[1].step_payload)), [20, 1]).v.toString(), 'It is 4.');
  assert.equal(find(decode(Buffer.from(steps[1].step_payload)), [20, 14]), null);
  assert.equal(find(decode(Buffer.from(d.prepare('select data from trajectory_metadata_blob').get().data)), [6]).v.toString(), convId);
  d.close();
  const s = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true });
  const row = s.prepare('select * from conversation_summaries where conversation_id=?').get(convId);
  assert.equal(row.title, 'Math'); assert.equal(row.step_count, 2); assert.equal(row.workspace_uris, ''); assert.equal(row.project_id, 'outside-of-project');
  s.close();
  assert.equal(exportSessions({ stores: [store], sessions: sess, state, env }).skipped, 1); // unchanged transcript
  const w = new DatabaseSync(join(store, 'conversations', convId + '.db'));
  w.prepare('insert into steps (idx,step_type,status,step_payload) values (2,14,3,?)').run(Buffer.from([8, 14])); w.close();
  writeFileSync(tr, readFileSync(tr, 'utf8') + '\n' + JSON.stringify({ type: 'user', message: { content: 'more' } }));
  state['sess-1'].mtime = 0;
  assert.equal(exportSessions({ stores: [store], sessions: sess, state, env }).keptAntigravityEdits, 1);
});
