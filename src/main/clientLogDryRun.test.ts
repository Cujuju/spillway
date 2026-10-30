import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openActivityDb } from './activityDb';
import { clientLogRoots, importClientFile } from './clientLogSync';
import { reconcileUsage, rememberUsage } from './usageLedger';
import type { ActivityEvent } from '@shared/types';

/** Opt-in diagnostic: reads the existing encrypted database without migrations; writes only to a disposable database. */
it.skipIf(!process.env.SPILLWAY_USAGE_DB_KEY)('dry-runs real logs against a read-only proxy snapshot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-real-usage-'));
  const temp = openActivityDb(path.join(dir, 'dry-run.db'), 'cd'.repeat(32));
  const file = process.env.SPILLWAY_USAGE_DB!;
  const real = new Database(file, { readonly: true, fileMustExist: true });
  const counts: Record<string, { parsed: number; matched: number; first: string; last: string }> = {};
  try {
    real.pragma("cipher='chacha20'");
    real.pragma(`hexkey='${process.env.SPILLWAY_USAGE_DB_KEY}'`);
    const rows = real.prepare('SELECT id, event FROM requests').all() as { id: number; event: string }[];
    for (const row of rows) {
      const e = JSON.parse(row.event) as ActivityEvent;
      if (e.source === 'client-log') continue;
      rememberUsage(temp, { ...e, source: 'proxy', upstreamId: e.upstreamId ?? null, cacheWriteTokens: e.cacheWriteTokens ?? 0 }, row.id);
    }
    let id = rows.length + 1;
    for (const root of clientLogRoots()) {
      const c = counts[root.provider] = { parsed: 0, matched: 0, first: '', last: '' };
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const name = path.join(folder, entry.name);
          if (entry.isDirectory()) await walk(name);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) await importClientFile(name, root.provider, {
            checkpoint: (f) => (temp.prepare('SELECT state FROM client_log_checkpoints WHERE path = ?').get(f) as { state: string } | undefined)?.state,
            importBatch: (f, s, events) => temp.transaction(() => {
              for (const e of events) {
                if (temp.prepare('SELECT 1 FROM usage_identities WHERE key = ?').get(`client-log:${e.requestId}`)) continue;
                c.parsed++;
                if (!c.first || e.at < c.first) c.first = e.at;
                if (!c.last || e.at > c.last) c.last = e.at;
                if (reconcileUsage(temp, e).skip) c.matched++;
                else rememberUsage(temp, e, id++);
              }
              temp.prepare('INSERT OR REPLACE INTO client_log_checkpoints VALUES (?, ?)').run(f, s);
            })(),
          });
        }
      };
      await walk(root.dir);
      console.log(JSON.stringify({ source: root.provider, ...c }));
    }
    const report = JSON.stringify({ storedRows: rows.length, sources: counts });
    console.log(report);
    if (process.env.SPILLWAY_USAGE_REPORT) await writeFile(process.env.SPILLWAY_USAGE_REPORT, report);
    expect(counts.claude?.parsed).toBeGreaterThan(0);
    expect(counts.codex?.parsed).toBeGreaterThan(0);
  } finally { real.close(); temp.close(); await rm(dir, { recursive: true, force: true }); }
}, 600_000);
