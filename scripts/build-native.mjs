#!/usr/bin/env node
// macOS only: compiles native/darwin/quitReason.m into a universal (arm64 + x86_64) Node-API addon at
// resources/native/darwin/quit-reason.node, which electron-builder.ts ships and src/main/quitReason.ts loads.
// Elsewhere it does nothing. Without Xcode's command-line tools it warns: the app then quits from the Dock without asking.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIT_REASON_ADDON = path.join(root, 'resources', 'native', 'darwin', 'quit-reason.node');

if (process.platform === 'darwin') {
  mkdirSync(path.dirname(QUIT_REASON_ADDON), { recursive: true });
  const r = spawnSync('xcrun', [
    'clang', '-bundle', '-undefined', 'dynamic_lookup', '-fobjc-arc', '-Wall', '-Werror', '-O2',
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0',
    '-framework', 'Foundation', '-framework', 'CoreServices',
    '-o', QUIT_REASON_ADDON, path.join(root, 'native', 'darwin', 'quitReason.m'),
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn(`build-native: couldn't build ${path.relative(root, QUIT_REASON_ADDON)} (install Xcode's command-line tools); Dock Quit won't ask first.`);
    if (process.env.CI) process.exit(1);
  }
}
