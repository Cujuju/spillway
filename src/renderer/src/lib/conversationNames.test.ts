import { describe, expect, it } from 'vitest';
import { shortConversationId } from './conversationNames';

describe('shortConversationId', () => {
  it("shows the start of the client's own ID and marks subagents", () => {
    expect(shortConversationId('claude:839993f5-1b6e-4df8-9026-3ff1a1c0d7a4')).toBe('839993f5');
    expect(shortConversationId('codex:01a107db-213a:agent:reviewer')).toBe('01a107db › agent');
  });
});
