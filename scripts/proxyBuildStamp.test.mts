import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isUpToDate, sourceState, writeStamp } from './proxyBuildStamp.mts';

let dir: string;
// Empty hooksPath: a machine-wide hook would run on every fixture commit.
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'proxy-stamp-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sourceState', () => {
  beforeEach(() => {
    git('init', '-q');
    write('main.go', 'package main\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  it('is stable while nothing changes', () => {
    expect(sourceState(dir)).toBe(sourceState(dir));
  });

  it('changes with tracked edits, untracked files and their content', () => {
    const clean = sourceState(dir);
    write('main.go', 'package main\n// edit\n');
    const edited = sourceState(dir);
    expect(edited).not.toBe(clean);
    write('extra.go', 'package main\n');
    const added = sourceState(dir);
    expect(added).not.toBe(edited);
    write('extra.go', 'package main\n// changed\n');
    expect(sourceState(dir)).not.toBe(added);
  });

  it('changes with a new commit', () => {
    const before = sourceState(dir);
    write('main.go', 'package main\n// next\n');
    git('commit', '-q', '-am', 'next');
    expect(sourceState(dir)).not.toBe(before);
  });

  it('ignores the build output folder', () => {
    const before = sourceState(dir);
    write('dist/win32-x64/cli-proxy-api.exe', 'binary');
    expect(sourceState(dir)).toBe(before);
  });
});

describe('build stamp', () => {
  const binary = () => path.join(dir, 'bin', 'cli-proxy-api');

  it('matches only the binary and key it recorded', () => {
    write('bin/cli-proxy-api', 'build 1');
    expect(isUpToDate(binary(), 'k1')).toBe(false);
    writeStamp(binary(), 'k1');
    expect(isUpToDate(binary(), 'k1')).toBe(true);
    expect(isUpToDate(binary(), 'k2')).toBe(false);
  });

  it('rejects a binary replaced after the stamp', () => {
    write('bin/cli-proxy-api', 'build 1');
    writeStamp(binary(), 'k1');
    write('bin/cli-proxy-api', 'build 2 from elsewhere');
    expect(isUpToDate(binary(), 'k1')).toBe(false);
    write('bin/cli-proxy-api', 'build 1');
    utimesSync(binary(), new Date(0), new Date(0));
    expect(isUpToDate(binary(), 'k1')).toBe(false);
  });

  it('rejects a missing binary or an unreadable stamp', () => {
    write('bin/cli-proxy-api', 'build 1');
    writeStamp(binary(), 'k1');
    write('bin/build-stamp.json', '{not json');
    expect(isUpToDate(binary(), 'k1')).toBe(false);
    write('bin/build-stamp.json', 'null');
    expect(isUpToDate(binary(), 'k1')).toBe(false);
    rmSync(binary());
    expect(isUpToDate(binary(), 'k1')).toBe(false);
  });
});
