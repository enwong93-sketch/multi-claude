import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSides } from './sync.mjs';

export function desktopSessions(cfg) {
  const sessions = new Map();
  for (const { dir } of discoverSides(cfg)) {
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!/^local_[\da-f-]+\.json$/i.test(file)) continue;
      let j;
      try { j = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
      if (!j?.cliSessionId || j.spawnedFrom?.btw) continue;
      const id = j.sessionId || file.slice(6, -5);
      const activity = Number(j.lastActivityAt) || 0;
      const completed = Number(j.completedTurns) || 0;
      const previous = sessions.get(id);
      if (previous && (previous.activity > activity ||
        (previous.activity === activity && previous.completed > completed) ||
        (previous.activity === activity && previous.completed === completed && !j.isArchived))) continue;
      const priorCliSessionIds = Array.isArray(j.priorCliSessionIds) ? [...new Set(j.priorCliSessionIds.filter(x => typeof x === 'string' && x !== j.cliSessionId))] : [];
      sessions.set(id, {
        id, cliSessionId: j.cliSessionId, priorCliSessionIds, activity, completed,
        indexFile: join(dir, file),
        rewinds: Array.isArray(j.rewindEdges) ? j.rewindEdges : [],
        archived: !!j.isArchived, title: j.title || '', cwd: j.cwd || j.originCwd || null,
      });
    }
  }
  return [...sessions.values()].filter(s => !s.archived).sort((a, b) => b.activity - a.activity);
}
