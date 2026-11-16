import { expect, it } from 'vitest';
import { management } from '../../src/main/managementClient';
import { generate } from './fixtures.mts';
import { startDemoProxy } from './server.mts';

it('redeems one selected type through the management client without substituting a remaining grant', async () => {
  const demo = await startDemoProxy(generate(Date.parse('2026-11-15T12:00:00Z')));
  try {
    management.configure(demo.endpoint, '');
    const initial = await management.usage();
    const claude = initial.credentials.find((c) => c.provider === 'claude')!;
    const fable = claude.resetCredits!.grants!.find((g) => g.scope === 'fable')!;
    const general = claude.resetCredits!.grants!.find((g) => g.scope === 'general')!;
    const redeemed = await management.useResetCredit(claude.authIndex, fable.id);
    expect(redeemed.outcome).toBe('reset');
    expect(redeemed.snapshot.credentials.find((c) => c.id === claude.id)!.resetCredits!.grants).toEqual([general]);
    const replay = await management.useResetCredit(claude.authIndex, fable.id);
    expect(replay.outcome).toBe('no_credit');
    expect(replay.snapshot.credentials.find((c) => c.id === claude.id)!.resetCredits!.grants).toEqual([general]);
  } finally { await demo.close(); }
});
