import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EVERY_REQUEST } from '@shared/activityScope';
import { ActivityLog } from './activityStore';
import { openActivityDb } from './activityDb';
import { parseActivityEvent } from './sse';

it('persists attempt transport across reopen and export; old rows and client imports stay unknown', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-transport-'));
  const file = path.join(dir, 'activity.db');
  const key = 'ab'.repeat(32);
  const config = { activityDb: file, legacyActivityDir: path.join(dir, 'legacy'), databaseKey: key, retentionDays: 30 };
  const log = new ActivityLog(config);
  const at = new Date().toISOString();
  try {
    const observed = parseActivityEvent(JSON.stringify({ at, request_id: 'observed', downstream_transport: 'http', upstream_transport: 'websocket+http', transport_fallback_reason: 'websocket_upgrade_426' }))!;
    log.append(observed);
    log.append({ ...parseActivityEvent(JSON.stringify({ at, request_id: 'client' }))!, source: 'client-log' });
    log.close();
    const db = openActivityDb(file, key);
    try {
      const historical = parseActivityEvent(JSON.stringify({ at, request_id: 'historical', stream: true }))!;
      delete historical.downstreamTransport; delete historical.upstreamTransport; delete historical.transportFallbackReason;
      db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)').run(at.slice(0, 10), 0, JSON.stringify(historical));
    } finally { db.close(); }
    const rows = log.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: null }).events;
    expect(rows.find((r) => r.requestId === 'observed')).toMatchObject({ downstreamTransport: 'http', upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' });
    for (const id of ['client', 'historical']) expect(rows.find((r) => r.requestId === id)).toMatchObject({ downstreamTransport: null, upstreamTransport: null, transportFallbackReason: null });
    expect([...log.exportEvents()].find((r) => r.requestId === 'observed')).toMatchObject({ upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' });
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
