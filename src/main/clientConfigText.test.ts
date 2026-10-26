import { describe, expect, it } from 'vitest';
import {
  applyClaude, applyCodex, claudeState, codexState, DISABLED_PREFIX, undoClaude, undoCodex,
} from './clientConfigText';

const target = { endpoint: 'http://127.0.0.1:8317', key: 'k1' };
const moved = { ...target, endpoint: 'http://127.0.0.1:9000' };

describe('Claude Code settings.json', () => {
  const original = '{\n  "model": "opus",\n  "env": {\n    "FOO": "1",\n    "ANTHROPIC_BASE_URL": "https://old"\n  },\n  "theme": "dark"\n}\n';

  it('sets both variables and keeps other content and key order', () => {
    const out = applyClaude(original, target);
    expect(JSON.parse(out)).toEqual({
      model: 'opus',
      env: { FOO: '1', ANTHROPIC_BASE_URL: target.endpoint, ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: k1' },
      theme: 'dark',
    });
    expect(Object.keys(JSON.parse(out))).toEqual(['model', 'env', 'theme']);
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('creates settings from a missing file', () => {
    expect(JSON.parse(applyClaude(null, target))).toEqual({ env: { ANTHROPIC_BASE_URL: target.endpoint, ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: k1' } });
  });

  // A token switches Claude Code out of its subscription login, which hides usage-limit resets.
  it('removes ANTHROPIC_AUTH_TOKEN and undo puts it back', () => {
    const legacy = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",\n    "ANTHROPIC_AUTH_TOKEN": "k1"\n  }\n}\n';
    const out = applyClaude(legacy, target);
    expect(JSON.parse(out).env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(undoClaude(out, legacy)).toBe(legacy);
    expect(claudeState(legacy, target, true)).toBe('out-of-date');
  });

  it('keeps other custom headers and replaces an old key header', () => {
    const withHeaders = JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Trace: on\nx-api-key: old' } });
    const out = applyClaude(withHeaders, target);
    expect(JSON.parse(out).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Trace: on\nX-Api-Key: k1');
    expect(claudeState(out, target, true)).toBe('applied');
    expect(JSON.parse(undoClaude(out, withHeaders)).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Trace: on\nx-api-key: old');
  });

  it('re-applies idempotently', () => {
    const once = applyClaude(original, target);
    expect(applyClaude(once, target)).toBe(once);
  });

  it('undo restores the backed-up values and keeps later edits', () => {
    const applied = JSON.parse(applyClaude(original, target));
    applied.env.LATER = 'x';
    applied.extra = true;
    const out = JSON.parse(undoClaude(JSON.stringify(applied, null, 2), original));
    expect(out.env).toEqual({ FOO: '1', ANTHROPIC_BASE_URL: 'https://old', LATER: 'x' });
    expect(out.extra).toBe(true);
  });

  it('undo of an apply to a file without env restores it exactly', () => {
    const plain = '{\n  "model": "opus"\n}\n';
    expect(undoClaude(applyClaude(plain, target), plain)).toBe(plain);
  });

  it('keeps CRLF line endings', () => {
    const crlf = original.replace(/\n/g, '\r\n');
    const out = applyClaude(crlf, target);
    expect(out.split('\r\n').length).toBeGreaterThan(1);
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect(undoClaude(out, crlf)).toBe(crlf);
  });

  it('rejects invalid JSON', () => {
    expect(() => applyClaude('{ nope', target)).toThrow(/not valid JSON/);
  });

  it('reports state from the backup and the current values', () => {
    const out = applyClaude(original, target);
    expect(claudeState(out, target, false)).toBe('not-applied');
    expect(claudeState(out, target, true)).toBe('applied');
    expect(claudeState(out, moved, true)).toBe('out-of-date');
    expect(claudeState(out, { ...target, key: 'k2' }, true)).toBe('out-of-date');
  });
});

describe('Codex config.toml', () => {
  const original = '# my config\nmodel = "gpt-5"\nmodel_provider = "openai"\n\n[model_providers.other]\nname = "x"\nmodel_provider = "kept"\n';
  const rootBlock =
    'openai_base_url = "http://127.0.0.1:8317/backend-api/codex"\n' +
    'chatgpt_base_url = "http://127.0.0.1:8317/backend-api/"\ncli_auth_credentials_store = "file"\n';

  it('points the built-in OpenAI provider at the proxy, disabling a root model_provider', () => {
    const out = applyCodex(original, target);
    expect(out.split('\n')[1]).toBe('openai_base_url = "http://127.0.0.1:8317/backend-api/codex"');
    expect(out).toContain(rootBlock);
    // Any provider but the built-in one would bypass the proxy and lose Codex's OpenAI-only tools.
    expect(out).toContain(`${DISABLED_PREFIX}model_provider = "openai"`);
    // Inside a table it is a different key: untouched.
    expect(out).toContain('\nmodel_provider = "kept"\n');
    // Codex authenticates with the pool login in auth.json; the key is never written here.
    expect(out).not.toContain('k1');
    expect(out).not.toContain('[model_providers.spillway');
  });

  it('undo restores the original exactly', () => {
    expect(undoCodex(applyCodex(original, target))).toBe(original);
  });

  it("turns off the user's own values for the keys it sets, and undo restores them", () => {
    const own = 'openai_base_url = "https://example.test/v1"\nchatgpt_base_url = "https://example.test/"\ncli_auth_credentials_store = "keyring"\n';
    const out = applyCodex(own, target);
    for (const line of own.trim().split('\n')) expect(out).toContain(`${DISABLED_PREFIX}${line}`);
    expect(undoCodex(out)).toBe(own);
  });

  it('re-applies idempotently and updates values', () => {
    const once = applyCodex(original, target);
    expect(applyCodex(once, target)).toBe(once);
    const again = applyCodex(once, moved);
    expect(again).toContain('openai_base_url = "http://127.0.0.1:9000/backend-api/codex"');
    expect(again.match(/openai_base_url = /g)).toHaveLength(1);
    expect(undoCodex(again)).toBe(original);
  });

  it('replaces an older apply that used a custom provider', () => {
    const marker = '# >>> spillway: added by Spillway; remove it with Undo in the app\n';
    const older =
      `${marker}model_provider = "spillway"\n# <<< spillway\n${original}` +
      `${marker}[model_providers.spillway]\nname = "Spillway"\n# <<< spillway\n`;
    expect(codexState(older, target)).toBe('out-of-date');
    const out = applyCodex(older, target);
    expect(out).toBe(applyCodex(original, target));
    expect(undoCodex(out)).toBe(original);
  });

  it('creates config from a missing file and undoes to empty', () => {
    const out = applyCodex(null, target);
    expect(out).toContain(rootBlock);
    expect(undoCodex(out)).toBe('');
  });

  it('keeps CRLF line endings', () => {
    const crlf = original.replace(/\n/g, '\r\n');
    const out = applyCodex(crlf, target);
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect(undoCodex(out)).toBe(crlf);
  });

  it('refuses an unterminated block', () => {
    expect(() => applyCodex('# >>> spillway\nmodel_provider = "x"\n', target)).toThrow(/without/);
  });

  it('reports state', () => {
    const out = applyCodex(original, target);
    expect(codexState(original, target)).toBe('not-applied');
    expect(codexState(out, target)).toBe('applied');
    expect(codexState(out, moved)).toBe('out-of-date');
    // The key is not in config.toml; the pool login in auth.json tracks it (clientSetup.ts).
    expect(codexState(out, { ...target, key: 'k2' })).toBe('applied');
    // A root model_provider added later would route around the proxy.
    expect(codexState(out.replace('# my config', 'model_provider = "openai"'), target)).toBe('out-of-date');
  });
});
