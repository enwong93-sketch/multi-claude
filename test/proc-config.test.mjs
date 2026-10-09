import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeOf, isMainProcess, endResumeProcesses } from '../src/proc.mjs';
import { addRuntime, allRuntimes, validateName, DEFAULTS } from '../src/config.mjs';

const rts = [
  { name: 'A', userData: 'C:\\Users\\me\\AppData\\Roaming\\Claude', primary: true },
  { name: 'B', userData: 'D:\\Runtimes\\B\\profile' },
  { name: 'C', userData: 'D:\\Runtimes\\C\\profile' },
];
const ID = '6530f31e-d4f4-484a-9374-b4f940e52948';

test('processes are attributed to the right runtime', () => {
  assert.equal(runtimeOf('"C:\\Program Files\\WindowsApps\\Claude_1\\app\\Claude.exe" --user-data-dir="D:\\Runtimes\\B\\profile"', rts).name, 'B');
  assert.equal(runtimeOf('D:\\Runtimes\\C\\profile\\claude-code\\2.1\\x\\claude.exe --output-format stream-json --resume=' + ID, rts).name, 'C');
  assert.equal(runtimeOf('C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1\\x\\claude.exe --output-format stream-json', rts).name, 'A');
  assert.equal(runtimeOf('"C:\\Program Files\\WindowsApps\\Claude_1\\app\\Claude.exe"', rts).name, 'A');
  assert.equal(runtimeOf('Claude.exe --user-data-dir=E:\\other', rts), null);
});

test('main process detection ignores helpers and conversation engines', () => {
  assert.equal(isMainProcess('Claude.exe --user-data-dir=x'), true);
  assert.equal(isMainProcess('Claude.exe --type=renderer'), false);
  assert.equal(isMainProcess('claude.exe --output-format stream-json'), false);
});

test('only the named runtime\'s engine for that conversation is selected', () => {
  const killed = [];
  const orig = process.kill; process.kill = pid => { killed.push(pid); };
  try {
    const list = [
      { pid: 1, cmd: `D:\\Runtimes\\B\\profile\\claude-code\\v\\claude.exe --output-format stream-json --resume=${ID}` },
      { pid: 2, cmd: `C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\v\\claude.exe --output-format stream-json --resume=${ID}` },
      { pid: 3, cmd: `D:\\Runtimes\\B\\profile\\claude-code\\v\\claude.exe --output-format stream-json --resume=11111111-1111-1111-1111-111111111111` },
    ];
    assert.deepEqual(endResumeProcesses('B', ID, rts, list), [1]);
    assert.deepEqual(killed, [1]);
    assert.deepEqual(endResumeProcesses('B', 'not-an-id', rts, list), []);
  } finally { process.kill = orig; }
});

test('runtime names and profiles are validated', () => {
  const cfg = { home: 'D:\\h', ...DEFAULTS, primary: { name: 'A', userData: 'C:\\x\\Claude' }, runtimes: [] };
  assert.throws(() => validateName('bad name'));
  addRuntime(cfg, 'B');
  assert.equal(allRuntimes(cfg).length, 2);
  assert.throws(() => addRuntime(cfg, 'b'), /already exists/);
  assert.throws(() => addRuntime(cfg, 'D', cfg.runtimes[0].profile), /already used/);
});
