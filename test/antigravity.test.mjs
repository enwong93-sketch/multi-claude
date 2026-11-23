import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { decode, encode, find, setText } from '../src/pb.mjs';
import { claudeTurns, stableUuid, exportSessions } from '../src/antigravity.mjs';

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
  const convId = state['sess-1'].convId;
  const d = new DatabaseSync(join(store, 'conversations', convId + '.db'), { readOnly: true });
  const steps = d.prepare('select * from steps order by idx').all();
  assert.equal(steps.length, 2);
  assert.equal(find(decode(Buffer.from(steps[0].step_payload)), [19, 3, 1]).v.toString(), 'what is 2+2?');
  assert.equal(find(decode(Buffer.from(steps[1].step_payload)), [20, 1]).v.toString(), 'It is 4.');
  assert.equal(find(decode(Buffer.from(steps[1].step_payload)), [20, 14]), null);
  assert.equal(find(decode(Buffer.from(d.prepare('select data from trajectory_metadata_blob').get().data)), [6]).v.toString(), convId);
  d.close();
  const s = new DatabaseSync(join(store, 'conversation_summaries.db'), { readOnly: true });
  const row = s.prepare('select * from conversation_summaries where conversation_id=?').get(convId);
  assert.equal(row.title, 'Math'); assert.equal(row.step_count, 2); assert.match(row.workspace_uris, /D:\/Proj/);
  s.close();
  assert.equal(exportSessions({ stores: [store], sessions: sess, state, env }).skipped, 1); // unchanged transcript
  const w = new DatabaseSync(join(store, 'conversations', convId + '.db'));
  w.prepare('insert into steps (idx,step_type,status,step_payload) values (2,14,3,?)').run(Buffer.from([8, 14])); w.close();
  writeFileSync(tr, readFileSync(tr, 'utf8') + '\n' + JSON.stringify({ type: 'user', message: { content: 'more' } }));
  state['sess-1'].mtime = 0;
  assert.equal(exportSessions({ stores: [store], sessions: sess, state, env }).keptAntigravityEdits, 1);
});
