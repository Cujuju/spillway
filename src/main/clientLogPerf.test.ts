import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { zstdCompressSync } from 'node:zlib';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => ({} as Record<string, { calls: number; ms: number }>));
function timed(name: string, fn: (...args: any[]) => any) {
  return (...args: any[]) => {
    const start = performance.now();
    const finish = () => { const m = metrics[name] ??= { calls: 0, ms: 0 }; m.calls++; m.ms += performance.now() - start; };
    const result = fn(...args);
    if (result instanceof Promise) return result.finally(finish);
    finish(); return result;
  };
}
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, stat: (...args: any[]) => timed('stat', fs.stat as any)(...args),
    readdir: (...args: any[]) => timed('readdir', fs.readdir as any)(...args),
    opendir: (...args: any[]) => timed('opendir', async () => {
      const dir = await (fs.opendir as any)(...args);
      const iterate = dir[Symbol.asyncIterator].bind(dir);
      dir[Symbol.asyncIterator] = () => {
        const iterator = iterate();
        iterator.next = timed('walk', iterator.next.bind(iterator));
        return iterator;
      };
      return dir;
    })(),
    open: (...args: any[]) => timed('open', async () => {
      const handle = await (fs.open as any)(...args);
      handle.read = timed('read', handle.read.bind(handle));
      return handle;
    })(),
  };
});
vi.mock('node:zlib', async (original) => {
  const mod = await original<typeof import('node:zlib')>();
  return { ...mod, createZstdDecompress: () => {
    const start = performance.now();
    const stream = mod.createZstdDecompress();
    stream.on('end', () => { const m = metrics.zstd ??= { calls: 0, ms: 0 }; m.calls++; m.ms += performance.now() - start; });
    return stream;
  } };
});
vi.mock('./clientLogParser', async (original) => {
  const mod = await original<typeof import('./clientLogParser')>();
  return { ...mod, parseClientLine: (...args: any[]) => timed('parse', mod.parseClientLine as any)(...args) };
});
vi.mock('./usageLedger', async (original) => {
  const mod = await original<typeof import('./usageLedger')>();
  return { ...mod, reconcileUsage: (...args: any[]) => timed('ledger', mod.reconcileUsage as any)(...args) };
});
it.skipIf(!process.env.SPILLWAY_BENCH)('measures a synthetic client-log poll', async () => {
  const { startClientLogSync } = await import('./clientLogSync');
  const { ActivityLog } = await import('./activityStore');
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-perf-'));
  const oldClaude = process.env.CLAUDE_CONFIG_DIR;
  const oldCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.CODEX_HOME = path.join(dir, 'codex');
  const log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 30 });
  const line = (id: string) => JSON.stringify({ type: 'assistant', sessionId: id, timestamp: new Date().toISOString(), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: 'x'.repeat(2048) } }) + '\n';
  const paths: string[] = [];
  const results: unknown[] = [];
  const channel = new MessageChannel();
  channel.port2.on('message', () => {});
  const broadcast = timed('broadcast', (message) => channel.port1.postMessage(message));
  try {
    for (let d = 0; d < 300; d++) {
      const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', `project-${d}`, 'sessions');
      await mkdir(folder, { recursive: true });
      for (let f = 0; f < 11; f++) {
        const file = path.join(folder, `${f}.jsonl${f === 10 ? '.zst' : ''}`);
        const body = Array.from({ length: 4 }, (_, n) => line(`${d}-${f}-${n}`)).join('');
        await writeFile(file, f === 10 ? zstdCompressSync(body) : body);
        if (f === 0) paths.push(file);
      }
    }
    const sink = { checkpoint: timed('checkpoint', log.checkpoint.bind(log)), importBatch: timed('dbBatch', log.importBatch.bind(log)) };
    const { parseClientLine } = await import('./clientLogParser');
    log.append({ ...parseClientLine(line('proxy-seed'), 'claude', {})!, source: 'proxy', authIndex: 'synthetic-account' });
    const poll = async (label: string) => {
      for (const key of Object.keys(metrics)) delete metrics[key];
      let progress = 0; let resets = 0;
      const cpu = process.cpuUsage(); const start = performance.now();
      let done!: () => void;
      const finished = new Promise<void>((resolve) => { done = resolve; });
      const stop = startClientLogSync(sink, () => {
        resets++; timed('prune', log.prune.bind(log))();
        broadcast({ event: 'reset' });
        timed('coverage', log.coverage.bind(log))();
        timed('resetQueries', () => { log.buckets(31); log.daySummaries(); log.page({ day: null, before: null, failedOnly: false, scope: { source: 'all', accounts: null, clients: null } }); })();
      }, (p) => { progress++; broadcast({ event: 'progress', value: p }); if (p.state === 'idle') done(); });
      await finished; await stop();
      const used = process.cpuUsage(cpu);
      results.push(structuredClone({ label, wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, progress, resets, metrics }));
      if (label === 'unchanged') {
        expect(resets).toBe(0);
        expect(metrics.open).toBeUndefined();
        expect(metrics.zstd).toBeUndefined();
        expect(metrics.dbBatch).toBeUndefined();
      }
    };
    await poll('seed');
    for (let run = 0; run < 3; run++) {
      await poll('unchanged');
      for (let n = 0; n < 5; n++) await appendFile(paths[n]!, line(`append-${run}-${n}`));
      await poll('append-five');
    }
  } finally {
    log.close();
    channel.port1.close(); channel.port2.close();
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    await rm(dir, { recursive: true, force: true });
    console.log(`Removed ${dir}`);
    await writeFile(path.join(tmpdir(), `spillway-bench-${process.env.SPILLWAY_BENCH}.json`), JSON.stringify({ dir, removed: true, results }, null, 2));
  }
}, 180_000);
