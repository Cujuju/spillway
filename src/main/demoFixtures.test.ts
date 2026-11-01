import { describe, expect, it } from 'vitest';
import { ACCOUNTS, generate, usageWindows } from '../../scripts/demo/fixtures.mts';
import { parseActivityEvent } from './sse';
import { parseUsageSnapshot } from './usageParse';

const NOW = Date.parse('2026-10-31T15:00:00Z');
/** RFC 2606 reserved domains: fake data must never name a real mailbox. */
const RESERVED_DOMAIN = /@example\.(com|org|net)$/;

describe('demo fixtures', () => {
  const data = generate(NOW);

  it('parse as the proxy usage payload, every account and window kept', () => {
    const snapshot = parseUsageSnapshot(usageWindows(data, new Map()));
    expect(snapshot.credentials.map((c) => c.id)).toEqual(ACCOUNTS.map((a) => a.id));
    for (const c of snapshot.credentials) {
      const spec = ACCOUNTS.find((a) => a.id === c.id)!;
      expect(c.windows.map((w) => w.key)).toEqual(spec.windows.map((w) => w.key));
      for (const w of c.windows) expect(w.usedPercent).toBeGreaterThanOrEqual(0);
    }
  });

  it('parse as request events', () => {
    expect(data.events.length).toBeGreaterThan(0);
    for (const e of data.events) expect(parseActivityEvent(JSON.stringify(e))).not.toBeNull();
  });

  it('use only reserved example domains', () => {
    for (const a of ACCOUNTS) if (a.email) expect(a.email).toMatch(RESERVED_DOMAIN);
  });

  it('are the same for the same start time', () => {
    expect(generate(NOW).events).toEqual(data.events);
  });
});
