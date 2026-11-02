import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execute }));
afterEach(() => { vi.unstubAllGlobals(); execute.mockReset(); });

it('applies the Linux drop-in through pkexec and removes its private staging file afterward', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  let staged = '';
  execute.mockImplementation((command: string, args: string[], done: (err: Error | null) => void) => {
    expect(command).toBe('pkexec');
    expect(args.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    const source = /\/bin\/cp '([^']+)'/.exec(args[2]!)![1]!;
    staged = source;
    expect(JSON.parse(readFileSync(source, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8317');
    expect(args[2]).toContain("'/etc/claude-code/managed-settings.d/spillway.json'");
    done(null);
  });
  const { applyManagedPolicy } = await import('./managedPolicy');
  await applyManagedPolicy({ endpoint: 'http://127.0.0.1:8317', key: 'test-client' });
  expect(() => readFileSync(staged)).toThrow();
});

it.each([[126, 'Administrator approval was declined'], ['ENOENT', 'Install polkit']] as const)(
  'surfaces Linux elevation failure %s', async (code, message) => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    execute.mockImplementation((_command: string, _args: string[], done: (err: Error) => void) => done(Object.assign(new Error('failed'), { code })));
    const { applyManagedPolicy } = await import('./managedPolicy');
    await expect(applyManagedPolicy({ endpoint: 'http://127.0.0.1:8317', key: 'test-client' })).rejects.toThrow(message);
  },
);
