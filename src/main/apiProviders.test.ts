import { describe, expect, it } from 'vitest';
import type { ApiProviderDraft } from '@shared/apiProviders';
import { applyDraft, keyId, maskKey, parseForEdit, readGroups, removeGroup, setKeyEnabled } from './apiProviders';

const USER = `# my notes
routing:
  request-retry: 2
api-keys:
  claude:
    - name: work
      priority: 5 # keep me
      keys:
        - api-key: sk-ant-aaaaaaaaaaaa1111
          weight: 3
        - api-key: sk-ant-bbbbbbbbbbbb2222
      models:
        - name: claude-opus-5-5
          alias: opus
          max-context-length: 1000000
`;

const draft = (over: Partial<ApiProviderDraft>): ApiProviderDraft => ({
  family: 'claude', name: 'work', baseUrl: '', prefix: '', disabled: false, keepKeys: [], newKeys: [], models: [], ...over,
});

describe('readGroups', () => {
  it('lists groups with masked keys and their models', () => {
    const [g] = readGroups(parseForEdit(USER));
    expect(g).toMatchObject({ family: 'claude', name: 'work', baseUrl: null, models: [{ name: 'claude-opus-5-5', alias: 'opus' }] });
    expect(g!.keys).toEqual([
      { id: keyId('sk-ant-aaaaaaaaaaaa1111'), masked: 'sk-a…1111' },
      { id: keyId('sk-ant-bbbbbbbbbbbb2222'), masked: 'sk-a…2222' },
    ]);
  });

  it('never exposes a short key', () => {
    expect(maskKey('abc')).toBe('••••');
  });
});

describe('applyDraft', () => {
  it('edits shown fields and keeps the rest of the file, its comments and per-key settings', () => {
    const doc = parseForEdit(USER);
    applyDraft(doc, draft({ keepKeys: [keyId('sk-ant-aaaaaaaaaaaa1111')], newKeys: ['sk-new-cccccccccccc3333'], models: [{ name: 'claude-opus-5-5', alias: 'big' }] }), { family: 'claude', name: 'work' });
    const out = doc.toString();
    expect(out).toContain('# my notes');
    expect(out).toContain('request-retry: 2');
    expect(out).toContain('priority: 5 # keep me');
    expect(out).toContain('weight: 3');
    expect(out).not.toContain('sk-ant-bbbbbbbbbbbb2222');
    expect(out).toContain('api-key: sk-new-cccccccccccc3333');
    expect(out).toContain('max-context-length: 1000000');
    expect(readGroups(doc)[0]!.models).toEqual([{ name: 'claude-opus-5-5', alias: 'big' }]);
  });

  it('adds a keyless OpenAI-compatible group and creates its family list', () => {
    const doc = parseForEdit('');
    applyDraft(doc, draft({ family: 'openai-compatibility', name: 'local', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ name: 'qwen3', alias: null }] }), null);
    expect(readGroups(doc)).toEqual([
      { family: 'openai-compatibility', name: 'local', baseUrl: 'http://127.0.0.1:11434/v1', prefix: null, disabled: false, keys: [], models: [{ name: 'qwen3', alias: null }] },
    ]);
  });

  it('rejects a key id the file no longer has, a duplicate name, and a missing key', () => {
    const doc = parseForEdit(USER);
    expect(() => applyDraft(doc, draft({ keepKeys: ['0000000000000000'] }), { family: 'claude', name: 'work' })).toThrow(/changed since/);
    expect(() => applyDraft(doc, draft({ newKeys: ['k'] }), null)).toThrow(/already exists/);
    expect(() => applyDraft(doc, draft({ name: 'other' }), null)).toThrow(/at least one API key/);
  });
});

describe('removeGroup', () => {
  it('disables and re-enables one key without losing keys, comments or per-key settings', () => {
    const doc = parseForEdit(USER);
    const first = keyId('sk-ant-aaaaaaaaaaaa1111');
    setKeyEnabled(doc, 'claude', 'work', first, false);
    const reopened = parseForEdit(doc.toString());
    expect(readGroups(reopened)[0]!.keys).toEqual([
      { id: first, masked: 'sk-a…1111', disabled: true },
      { id: keyId('sk-ant-bbbbbbbbbbbb2222'), masked: 'sk-a…2222' },
    ]);
    expect(reopened.toString()).toContain('weight: 3');
    expect(reopened.toString()).toContain('# keep me');
    setKeyEnabled(reopened, 'claude', 'work', first, true);
    expect(reopened.toString()).not.toContain('disabled:');
    expect(readGroups(reopened)[0]!.keys).toEqual(readGroups(parseForEdit(USER))[0]!.keys);
    expect(() => setKeyEnabled(reopened, 'claude', 'work', 'gone', false)).toThrow(/changed since/);
  });
  it('drops the group and the emptied section, keeping the rest', () => {
    const doc = parseForEdit(USER);
    removeGroup(doc, 'claude', 'work');
    const out = doc.toString();
    expect(out).not.toContain('api-keys');
    expect(out).toContain('request-retry: 2');
  });
});

describe('parseForEdit', () => {
  it('refuses a file with a syntax error instead of rewriting it', () => {
    expect(() => parseForEdit('a: [1, 2')).toThrow(/Fix config.user.yaml first/);
    expect(() => parseForEdit('- just\n- a list')).toThrow(/mapping/);
  });
});
