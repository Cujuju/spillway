import { expect, it, vi } from 'vitest';
import { runCanaryProbe } from './canaryRunner';
import { CANARY_PROBES } from '@shared/canary';
it('parses last answers, ignores thinking, records tokens and handles fail/error', async () => {
  const probe = CANARY_PROBES[0]!, target = { model: 'opus', effort: 'high' }, connection = { endpoint: 'http://localhost', clientApiKey: 'local-test' };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: 'ANSWER: wrong' }, { type: 'text', text: `ANSWER: wrong\nANSWER: ${probe.answer}` }], usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 0 } } })));
  expect(await runCanaryProbe(target, probe, 'batch', true, connection, fetcher)).toMatchObject({ outcome: 'pass', answer: probe.answer, thinkingTokens: 0, outputTokens: 10 });
  expect(fetcher.mock.calls[0]?.length).toBeGreaterThan(0);
  const wrong = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ANSWER: wrong' } }] })));
  expect((await runCanaryProbe(target, probe, 'batch', false, connection, wrong)).outcome).toBe('fail');
  const bad = vi.fn(async () => new Response('oops', { status: 500 }));
  expect(await runCanaryProbe(target, probe, 'batch', false, connection, bad)).toMatchObject({ outcome: 'error', error: 'Proxy returned HTTP 500' });
  const malformed = vi.fn(async () => new Response('no json'));
  expect((await runCanaryProbe(target, probe, 'batch', false, connection, malformed)).outcome).toBe('error');
});

it.each([true, false])('classifies truncated replies as errors (Claude: %s)', async (claude) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(claude
    ? { stop_reason: 'max_tokens', content: [] }
    : { choices: [{ finish_reason: 'length', message: { content: 'ANSWER: wrong' } }] })));
  expect(await runCanaryProbe({ model: 'test', effort: 'max' }, CANARY_PROBES[0]!, 'batch', claude,
    { endpoint: 'http://localhost', clientApiKey: 'test' }, fetcher)).toMatchObject({ outcome: 'error', error: 'Reply hit the output token limit' });
});
it.each(['**400**.', '_400._', '`400`', '400.'])('normalizes answer formatting %s', async (answer) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: `ANSWER: ${answer}` } }] })));
  expect((await runCanaryProbe({ model: 'test', effort: 'high' }, CANARY_PROBES[0]!, 'batch', false,
    { endpoint: 'http://localhost', clientApiKey: 'test' }, fetcher)).outcome).toBe('pass');
});
