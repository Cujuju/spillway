import { describe, expect, it } from 'vitest';
import {
  applyClaude, applyCodex, claudeState, codexState, DISABLED_PREFIX, undoClaude, undoCodex,
} from './clientConfigText';

const keyCommand = { command: 'C:\\Apps\\Spillway\\Spillway.exe', args: ['--print-client-key'] };
const target = { endpoint: 'http://127.0.0.1:8317', key: 'k1', keyCommand };
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

  it('adds the provider and makes it the default, disabling the old root model_provider', () => {
    const out = applyCodex(original, target);
    const lines = out.split('\n');
    expect(lines[1]).toBe('model_provider = "spillway"');
    expect(out).toContain(`${DISABLED_PREFIX}model_provider = "openai"`);
    // Inside a table it is a different key: untouched.
    expect(out).toContain('\nmodel_provider = "kept"\n');
    expect(out).toContain(
      '[model_providers.spillway]\nname = "Spillway"\nbase_url = "http://127.0.0.1:8317/v1"\nwire_api = "responses"\n' +
        '[model_providers.spillway.auth]\ncommand = "C:\\\\Apps\\\\Spillway\\\\Spillway.exe"\nargs = ["--print-client-key"]\n' +
        'refresh_interval_ms = 0\n',
    );
    // The command fetches the key; it is never written.
    expect(out).not.toContain('k1');
    expect(out.indexOf('[model_providers.spillway]')).toBeGreaterThan(out.indexOf('[model_providers.other]'));
  });

  it('undo restores the original exactly', () => {
    expect(undoCodex(applyCodex(original, target))).toBe(original);
  });

  it('re-applies idempotently and updates values', () => {
    const once = applyCodex(original, target);
    expect(applyCodex(once, target)).toBe(once);
    const again = applyCodex(once, moved);
    expect(again).toContain('base_url = "http://127.0.0.1:9000/v1"');
    expect(again.match(/\[model_providers.spillway\]/g)).toHaveLength(1);
    expect(undoCodex(again)).toBe(original);
  });

  it('creates config from a missing file and undoes to empty', () => {
    const out = applyCodex(null, target);
    expect(out).toContain('model_provider = "spillway"');
    expect(undoCodex(out)).toBe('');
  });

  it('keeps CRLF line endings', () => {
    const crlf = original.replace(/\n/g, '\r\n');
    const out = applyCodex(crlf, target);
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect(undoCodex(out)).toBe(crlf);
  });

  it('refuses when the file already defines the provider', () => {
    expect(() => applyCodex('[model_providers.spillway]\nname = "mine"\n', target)).toThrow(/already defines/);
    expect(() => applyCodex('[model_providers."spillway".http_headers]\n', target)).toThrow(/already defines/);
  });

  it('refuses an unterminated block', () => {
    expect(() => applyCodex('# >>> spillway\nmodel_provider = "x"\n', target)).toThrow(/without/);
  });

  it('reports state', () => {
    const out = applyCodex(original, target);
    expect(codexState(original, target)).toBe('not-applied');
    expect(codexState(out, target)).toBe('applied');
    expect(codexState(out, moved)).toBe('out-of-date');
    // A regenerated key needs no re-apply: Codex reruns the command after a 401.
    expect(codexState(out, { ...target, key: 'k2' })).toBe('applied');
    expect(codexState(out, { ...target, keyCommand: { ...keyCommand, command: 'D:\\Spillway.exe' } })).toBe('out-of-date');
    // Older applies stored the key itself; applying again replaces it.
    const legacy = out.replace(/\[model_providers\.spillway\.auth\][^#]*/, 'experimental_bearer_token = "k1"\n');
    expect(legacy).toContain('experimental_bearer_token');
    expect(codexState(legacy, target)).toBe('out-of-date');
    expect(applyCodex(legacy, target)).toBe(out);
    // A root model_provider added later clashes with ours.
    expect(codexState(out.replace('# my config', 'model_provider = "openai"'), target)).toBe('out-of-date');
  });
});
