const REDACTED = '[redacted]';
const secretField = (key: string) => /(?:authorization|authentication|credential|password|passwd|secret|cookie|headers?|apikey|token$|privatekey|clientkey|managementkey|databasekey|authfile)/i.test(key.replace(/[^a-z0-9]/gi, '')) || /^(?:auth|key)$/i.test(key);
const normalizeText = (value: string) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
function redactEmails(value: string): string {
  // Tokenize once, then inspect the @-containing tokens without repeated prefix matching.
  return value.replace(/[^\s<>"'()\[\]{};,]+/g, (token) => token.includes('@') && /@[^@]+\.[a-z]{2,63}/i.test(token) ? REDACTED : token);
}

export class DiagnosticSanitizer {
  changes = 0;
  truncations = 0;
  private aliases = new Map<string, Map<string, string>>();
  private knownSecrets: RegExp | null;
  constructor(knownSecrets: string[] = []) {
    const values = [...new Set(knownSecrets.map(normalizeText).filter(Boolean))].sort((a, b) => b.length - a.length);
    this.knownSecrets = values.length ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  }
  alias(kind: string, value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const group = this.aliases.get(kind) ?? new Map<string, string>();
    this.aliases.set(kind, group);
    if (!group.has(value)) group.set(value, `${kind}-${group.size + 1}`);
    this.changes++;
    return group.get(value)!;
  }
  text(value: string, limit = 4096): string {
    let result = normalizeText(value);
    if (this.knownSecrets) result = result.replace(this.knownSecrets, () => REDACTED);
    const bounded = result.length > limit + 512;
    if (bounded) result = result.slice(0, limit + 512);
    result = result
      .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g, REDACTED)
      .replace(/(?:Bearer|Basic)\s+[a-z0-9._~+\/-]+=*/gi, REDACTED)
      .replace(/(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)/gi, REDACTED)
      .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|authorization|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, REDACTED)
      .replace(/https?:\/\/[^\s<>"']+/gi, '[url omitted]')
      .replace(/\b[A-Z]:[\\/][^\s<>"']+|\/(?:Users|home|root|etc|var|tmp)\/[^\s<>"']+/g, '[path omitted]');
    result = redactEmails(result);
    if (bounded || result.length > limit) { result = `${result.slice(0, limit)}[truncated]`; this.truncations++; }
    if (result !== value) this.changes++;
    return result;
  }
  label(value: unknown): string | null { return typeof value === 'string' && value ? this.text(value, 160) : null; }
  /** Drops secret-bearing fields recursively; content strings still require the user's inspection. */
  payload(raw: string): { content?: unknown; reason?: string; partial: boolean } {
    if (Buffer.byteLength(raw) > 1024 * 1024) return { reason: 'input-byte-limit', partial: true };
    let nodes = 0, partial = false;
    const visit = (value: unknown, depth = 0): unknown => {
      if (++nodes > 10_000 || depth > 24) { partial = true; this.changes++; return '[structure limit]'; }
      if (typeof value === 'string') { if (value.length > 64 * 1024) partial = true; return this.text(value, 64 * 1024); }
      if (Array.isArray(value)) {
        if (value.length > 1000) { partial = true; this.changes++; }
        return value.slice(0, 1000).map((v) => visit(v, depth + 1));
      }
      if (value && typeof value === 'object') {
        const output: Record<string, unknown> = Object.create(null);
        const entries = Object.entries(value);
        if (entries.length > 1000) { partial = true; this.changes++; }
        for (const [key, child] of entries.slice(0, 1000)) {
          if (secretField(key)) { this.changes++; continue; }
          const safeKey = this.text(key, 160);
          if (safeKey !== key || ['__proto__', 'constructor', 'prototype'].includes(key)) { this.changes++; continue; }
          output[key] = visit(child, depth + 1);
        }
        return output;
      }
      return value;
    };
    try { return { content: visit(JSON.parse(raw)), partial }; }
    catch { /* Event streams are parsed structurally below; other wire text is omitted. */ }
    const events: unknown[] = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      if (events.length >= 1000) { partial = true; break; }
      try { events.push(visit(JSON.parse(data))); }
      catch { partial = true; }
    }
    return events.length ? { content: { events }, partial } : { reason: 'unstructured-or-invalid-payload', partial: true };
  }
}

export function diagnosticErrorClass(failed: boolean, status: number | null, error: string | null | undefined): string | null {
  if (!failed) return null;
  if (status === 429) return 'rate-limit';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  const message = typeof error === 'string' ? error.slice(0, 8192).toLowerCase() : '';
  if (/cancel|abort/.test(message)) return 'canceled';
  if (/timeout|timed out|deadline/.test(message)) return 'timeout';
  if (/connect|socket|econn|network|eof/.test(message)) return 'connection';
  if (status && status >= 500) return 'server';
  if (status && status >= 400) return 'client';
  return 'unknown';
}
