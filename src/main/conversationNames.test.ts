import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it, vi } from 'vitest';
import { claudeTranscriptTitle, codexIndexTitles, conversationNames, nativeConversationId } from './conversationNames';

describe('nativeConversationId', () => {
  it("takes the client's own ID, without a subagent suffix", () => {
    expect(nativeConversationId('claude:839993f5-1b6e-4df8-9026-3ff1a1c0d7a4')).toEqual({ client: 'claude', id: '839993f5-1b6e-4df8-9026-3ff1a1c0d7a4' });
    expect(nativeConversationId('codex:01a1:agent:reviewer')).toEqual({ client: 'codex', id: '01a1' });
    expect(nativeConversationId('agy:ea10694f-5ce1-4baa-a549-39472294d4a1')).toEqual({ client: 'agy', id: 'ea10694f-5ce1-4baa-a549-39472294d4a1' });
    expect(nativeConversationId('agy:ea10694f-5ce1-4baa-a549-39472294d4a1:agent:sub')).toEqual({ client: 'agy', id: 'ea10694f-5ce1-4baa-a549-39472294d4a1' });
    expect(nativeConversationId('opencode:x')).toBeNull();
  });
});

describe('Antigravity title resolution', () => {
  it('resolves T3 Code thread titles and falls back to Antigravity conversation_summaries.db', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spillway-ag-titles-'));
    const t3Dir = path.join(dir, 't3');
    const geminiDir = path.join(dir, 'gemini');
    const cliDir = path.join(geminiDir, 'antigravity-cli');
    vi.stubEnv('T3_USERDATA_DIR', t3Dir);
    vi.stubEnv('GEMINI_HOME', geminiDir);
    vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'claude'));
    try {
      await mkdir(t3Dir, { recursive: true });
      await mkdir(cliDir, { recursive: true });
      const t3Db = new Database(path.join(t3Dir, 'statev2.sqlite'));
      try {
        t3Db.exec(`
          CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT);
          CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT);
        `);
        t3Db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)').run('t1', 'Antigravity support');
        t3Db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)').run('t1', JSON.stringify({ nativeThreadRef: { nativeId: 'conv-t3' } }));
      } finally { t3Db.close(); }
      const sumDb = new Database(path.join(cliDir, 'conversation_summaries.db'));
      try {
        sumDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT)');
        sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('conv-t3', 'Summary fallback should lose to T3');
        sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('conv-cli', 'CLI conversation title');
      } finally { sumDb.close(); }
      const resolved = await conversationNames.names(['agy:conv-t3', 'agy:conv-cli', 'agy:missing']);
      expect(resolved).toEqual({
        'agy:conv-t3': 'Antigravity support',
        'agy:conv-cli': 'CLI conversation title',
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('claudeTranscriptTitle', () => {
  it('prefers the last title the user set over generated ones', () => {
    const lines = [
      '{"type":"ai-title","aiTitle":"First guess"}',
      '{"type":"custom-title","customTitle":"Mine"}',
      '{"type":"ai-title","aiTitle":"Later guess"}',
      '{"type":"custom-title","customTitle":"Mine, renamed"}',
      '{"type":"user","message":"x"}',
    ];
    expect(claudeTranscriptTitle(lines.join('\n'))).toBe('Mine, renamed');
    expect(claudeTranscriptTitle([lines[0], lines[2], '{"type":"ai-title",'].join('\n'))).toBe('Later guess');
    expect(claudeTranscriptTitle('{"type":"user"}')).toBeNull();
  });
});

describe('codexIndexTitles', () => {
  it('keeps the latest name per thread', () => {
    const titles = codexIndexTitles('{"id":"t1","thread_name":"Old"}\n{"id":"t2","thread_name":"Other"}\n{"id":"t1","thread_name":"New"}\n');
    expect(titles.get('t1')).toBe('New');
    expect(titles.get('t2')).toBe('Other');
  });
});
