import { describe, expect, it } from 'vitest';
import { claudeTranscriptTitle, codexIndexTitles, nativeConversationId } from './conversationNames';

describe('nativeConversationId', () => {
  it("takes the client's own ID, without a subagent suffix", () => {
    expect(nativeConversationId('claude:839993f5-1b6e-4df8-9026-3ff1a1c0d7a4')).toEqual({ client: 'claude', id: '839993f5-1b6e-4df8-9026-3ff1a1c0d7a4' });
    expect(nativeConversationId('codex:01a1:agent:reviewer')).toEqual({ client: 'codex', id: '01a1' });
    expect(nativeConversationId('opencode:x')).toBeNull();
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
