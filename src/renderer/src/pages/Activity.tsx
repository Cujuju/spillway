import { createMemo, createSignal, For, Show } from 'solid-js';
import { maskEmails } from '@shared/privacy';
import type { ActivityEvent } from '@shared/types';
import { Notice, ProviderGlyph, Seg } from '../components/ui';
import { activity, proxyStatus, setActivity, settings, snapshot } from '../store';

const MS_PER_SECOND = 1000;
/** Below this, show milliseconds; above, seconds with one decimal. */
const SHOW_SECONDS_FROM_MS = 1000;

const duration = (ms: number | null) => (ms === null ? '—' : ms < SHOW_SECONDS_FROM_MS ? `${ms} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} s`);
const tokens = (v: number) => v.toLocaleString();

export function Activity() {
  const [filter, setFilter] = createSignal<'all' | 'failed'>('all');
  // snapshot() is already masked when "Show emails" is off.
  const accountNames = createMemo(() => new Map((snapshot()?.credentials ?? []).map((c) => [c.authIndex, c.label])));
  const account = (e: ActivityEvent) => (e.authIndex ? (accountNames().get(e.authIndex) ?? e.authIndex) : '—');
  const errorText = (e: ActivityEvent) => {
    const text = e.error ?? '';
    return settings().dashboard.showEmails ? text : maskEmails(text);
  };
  const rows = createMemo(() => {
    const all = activity();
    const shown = filter() === 'failed' ? all.filter((e) => e.failed) : all;
    return [...shown].reverse();
  });
  const failedCount = () => activity().filter((e) => e.failed).length;

  return (
    <>
      <header class="dash-header">
        <div>
          <h1 class="dash-title">Activity</h1>
          <div class="dash-sub">Each upstream attempt, newest first · {activity().length} recent, {failedCount()} failed</div>
        </div>
        <div class="dash-actions">
          <Seg value={filter()} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }] as const} onChange={setFilter} />
          <button class="btn ghost" onClick={() => void window.api.clearActivity().then(() => setActivity([]))}>Clear</button>
        </div>
      </header>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>Activity appears while the proxy is running.</Notice>
      </Show>

      <div class="card" style={{ 'margin-top': '16px', padding: 0 }}>
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Account</th>
              <th>Model</th>
              <th>Result</th>
              <th title="Input / output / cached tokens">Tokens</th>
              <th title="Time to first token">First token</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()} fallback={<tr><td colSpan={7} class="muted">No requests yet.</td></tr>}>
              {(e) => (
                <tr>
                  <td class="mono">{new Date(e.at).toLocaleTimeString()}</td>
                  <td>
                    <div class="row" style={{ gap: '8px' }}>
                      <ProviderGlyph provider={e.provider} size={14} />
                      <span>{account(e)}</span>
                    </div>
                  </td>
                  <td class="mono">{e.model || '—'}</td>
                  <td>
                    <Show when={e.failed} fallback={<span class="badge green">OK</span>}>
                      <span class="badge red" title={errorText(e)}>{e.statusCode ?? 'Failed'}</span>
                      <span class="muted" style={{ 'margin-left': '6px' }}>{errorText(e)}</span>
                    </Show>
                  </td>
                  <td class="mono">{tokens(e.inputTokens)} / {tokens(e.outputTokens)} / {tokens(e.cachedTokens)}</td>
                  <td class="mono">{duration(e.ttftMs)}</td>
                  <td class="mono">{duration(e.latencyMs)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
}
