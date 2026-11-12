import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { generate } from './fixtures.mts';
import { startDemoProxy } from './server.mts';
import { ActivityLog } from '../../src/main/activityStore';
import { parseActivityEvent } from '../../src/main/sse';
import { ThinkingTestRunner } from '../../src/main/thinkingTestRunner';
import type { CapturePage } from '../../src/shared/archive';

// Local fake HTTP calls should finish within the normal unit-test deadline.
const DEMO_TEST_DEADLINE_MS = 5000;
// Poll progress without delaying completion until the deadline.
const DEMO_TEST_POLL_MS = 10;

it('runs a captured demo turn through replay, judge and persistence without real providers', async () => {
  const data = generate(Date.now()), server = await startDemoProxy(data);
  const dir = mkdtempSync(path.join(tmpdir(), 'thinking-demo-'));
  const log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'absent'), databaseKey: 'ab'.repeat(32), retentionDays: 30 });
  try {
    const management = `${server.endpoint}/v8/management`;
    await fetch(`${management}/observability/captures/lease`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const captures: CapturePage = { version: 1, epoch: '', dropped: 0, records: [] };
    for (;;) {
      const page = await (await fetch(`${management}/observability/captures?after=${captures.records.at(-1)?.sequence ?? 0}`)).json() as CapturePage;
      captures.epoch = page.epoch; if (!page.records.length) break; captures.records.push(...page.records);
    }
    const complete = captures.records.filter((r) => r.state === 'complete'); expect(complete.length).toBeGreaterThan(0);
    const ids = new Set(complete.map((r) => r.traceId));
    const events = data.events.filter((e) => ids.has(`demo-inbound-${e.request_id}`)).map((e) => parseActivityEvent(JSON.stringify({ ...e, trace_id: `demo-inbound-${e.request_id}` }))!);
    for (const e of events) { log.append(e); log.archiveObserve(e); }
    log.archivePolicy({ captureBodies: true, retentionDays: 7, maxBytes: 1024 * 1024 }); for (const record of captures.records) log.archiveIngest({ ...captures, records: [record] });
    const first = events[0]!, setting = { provider: first.provider, model: first.effectiveModel ?? first.model, effort: first.reasoningEffort! };
    const prepared = log.thinkingTestPrepare({ query: { from: 0, to: Date.now(), scope: { accounts: null, clients: null } }, setting, alternatives: [{ ...setting, effort: 'low' }], turns: 10 });
    expect(prepared.samples.length).toBeGreaterThan(0);
    const runner = new ThinkingTestRunner(() => ({ endpoint: server.endpoint, clientApiKey: 'synthetic' }), async (test) => log.thinkingTestSave(test));
    runner.prepare(prepared); runner.start(prepared.plan.id);
    const finished = await new Promise<ReturnType<typeof runner.status>>((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('Demo test deadline')); }, DEMO_TEST_DEADLINE_MS);
      const poll = setInterval(() => { const status = runner.status(prepared.plan.id); if (status.state !== 'running') { clearTimeout(deadline); clearInterval(poll); resolve(status); } }, DEMO_TEST_POLL_MS);
    });
    expect(finished.state).toBe('complete'); expect(finished.results[0]!.errors).toBe(0); expect(finished.done).toBe(finished.total);
    expect(finished.costUsd).toBeGreaterThan(0); expect(Object.values(log.thinkingTests())).toHaveLength(1);
  } finally { log.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
