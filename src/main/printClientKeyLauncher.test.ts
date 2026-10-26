import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const launcher = path.resolve(import.meta.dirname, '../../resources/print-client-key.cjs');
const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-launcher-'));
// Stands in for Spillway: reports what it was started with, then exits with a code the launcher must pass on.
const target = path.join(dir, 'target.cjs');
const TARGET_EXIT = 3;
writeFileSync(
  target,
  `process.stdout.write(JSON.stringify({ runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, args: process.argv.slice(2) }));
process.exit(${TARGET_EXIT});`,
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('print-client-key launcher', () => {
  it('re-runs the executable without ELECTRON_RUN_AS_NODE, passing on arguments, output and exit code', () => {
    // Node runs the launcher as Electron does under ELECTRON_RUN_AS_NODE; its re-run is Node too, so the target is a script.
    const run = spawnSync(process.execPath, [launcher, target, '--print-client-key'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(TARGET_EXIT);
    expect(JSON.parse(run.stdout)).toEqual({ runAsNode: null, args: ['--print-client-key'] });
  });
});
