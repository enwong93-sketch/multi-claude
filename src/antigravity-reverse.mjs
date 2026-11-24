import { execFileSync } from 'node:child_process';
import { stableUuid } from './antigravity.mjs';

export function claudeReverseRecords(head, messages, origin) {
  let parent = head.uuid;
  let timestamp = Date.parse(head.timestamp);
  if (head.type !== 'assistant' || !parent || !head.cwd || !head.version || !head.message?.model || !Number.isFinite(timestamp)) {
    throw new Error('Claude history does not end at a compatible assistant record.');
  }
  return messages.map(({ role, text, index, ts }) => {
    const uuid = stableUuid(`agy-reverse/${head.sessionId}/${origin}/${index}/${text}`);
    timestamp = Math.max(timestamp + 1, ts);
    const message = role === 'user' ? { role, content: text } : {
      role, id: `msg_${uuid.replaceAll('-', '')}`, model: head.message.model, type: 'message',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    };
    const row = {
      type: role, uuid, parentUuid: parent, sessionId: head.sessionId, cwd: head.cwd, version: head.version,
      userType: head.userType || 'external', isSidechain: false, message, timestamp: new Date(timestamp).toISOString(),
      multiClaude: { origin, nativeIndex: index },
    };
    parent = uuid;
    return row;
  });
}

export function appendLocked(file, snapshot, records) {
  // Deny other writers on Windows throughout the compare-and-append operation.
  const script = `
    $ErrorActionPreference='Stop'
    $p=[Console]::In.ReadToEnd() | ConvertFrom-Json
    $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p.path))
    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
    try {
      $ns=([IO.File]::GetLastWriteTimeUtc($file).Ticks - 621355968000000000L) * 100L
      if ($stream.Length -ne [long]$p.size -or $ns -ne [long]$p.mtimeNs) { throw 'Claude transcript changed.' }
      if ($stream.Length -lt 1) { throw 'Claude transcript is empty.' }
      [void]$stream.Seek(-1,[IO.SeekOrigin]::End)
      if ($stream.ReadByte() -ne 10) { throw 'Claude has an incomplete JSONL record.' }
      $bytes=[Convert]::FromBase64String($p.data)
      try {
        $stream.Write($bytes,0,$bytes.Length)
        $stream.Flush($true)
      } catch {
        $stream.SetLength([long]$p.size)
        $stream.Flush($true)
        throw
      }
    } finally { $stream.Dispose() }
  `;
  const data = records.map(record => JSON.stringify(record) + '\n').join('');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: JSON.stringify({ path: Buffer.from(file).toString('base64'), size: String(snapshot.size), mtimeNs: String(snapshot.mtimeNs),
      data: Buffer.from(data).toString('base64') }), timeout: 15000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
