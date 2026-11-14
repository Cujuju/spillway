import type { ActivityLog } from './activityStore';
import { conversationNames, MAX_IDS_PER_CALL } from './conversationNames';
import type { MirrorRecord } from './clickhouseRecords';

// Recently active sessions are re-read every pass; the rest on complete passes (startup, export or store turned on).
const TITLE_ACTIVE_WINDOW_MS = 24 * 60 * 60_000;
// Claude Code titles cost a transcript lookup per session; five minutes bounds that work while renames still arrive promptly.
const TITLE_EXPORT_INTERVAL_MS = 5 * 60_000;

async function exportTitles(log: ActivityLog, complete: boolean): Promise<void> {
  // A disabled store clears its mirror; nothing to read.
  if (!log.clickhouseExportsTitles()) { log.clickhouseMirrorTitles([], true); return; }
  const sessions = log.clickhouseSessions(complete ? null : Date.now() - TITLE_ACTIVE_WINDOW_MS);
  const records: MirrorRecord[] = [];
  for (let i = 0; i < sessions.length; i += MAX_IDS_PER_CALL) {
    const chunk = sessions.slice(i, i + MAX_IDS_PER_CALL);
    const titles = await conversationNames.names(chunk.map((s) => s.sessionId));
    for (const s of chunk) {
      const title = titles[s.sessionId];
      if (title) records.push({ kind: 'conversation-title', key: s.sessionId, at: s.at, record: JSON.stringify({ sessionId: s.sessionId, title }) });
    }
  }
  log.clickhouseMirrorTitles(records, complete);
}

/** Exports conversation titles as they appear or change; `refresh` runs a complete pass, `stop` waits for a running one. */
export function startTitleExport(log: ActivityLog): { refresh(): void; stop(): Promise<void> } {
  let running = Promise.resolve(), stopped = false;
  const run = (complete: boolean) => { running = running.then(() => stopped ? undefined : exportTitles(log, complete)).catch(console.error); };
  const timer = setInterval(() => run(false), TITLE_EXPORT_INTERVAL_MS);
  run(true);
  return { refresh: () => run(true), stop: async () => { stopped = true; clearInterval(timer); await running; } };
}
