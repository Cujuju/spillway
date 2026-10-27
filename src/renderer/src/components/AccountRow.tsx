import { RefreshCw, Settings2 } from 'lucide-solid';
import { createSignal, For, Show } from 'solid-js';
import { accountState } from '@shared/accountState';
import type { Credential } from '@shared/types';
import { compactDuration } from '../lib/format';
import { isExhausted } from '../lib/quotaColor';
import { now, setPage } from '../store';
import { LimitBar } from './LimitBar';
import { ProviderGlyph, ResetTime } from './ui';

const ICON_PX = 13;
/** Providers the proxy's on-demand usage lookup (POST /usage/refresh) supports. */
const LIVE_LOOKUP_PROVIDERS = new Set(['claude', 'codex']);

/** One account in Theo's list: name, refresh and state, then limit bars. */
export function AccountRow(props: { credential: Credential }) {
  const c = () => props.credential;
  const [busy, setBusy] = createSignal(false);
  const state = () => accountState(c(), now());
  /** Limited with no spent window to show it (e.g. a cooldown after errors): the reset goes in the meta lines. */
  const limitedUnshown = () => state() === 'limited' && !c().windows.some((w) => isExhausted(w.usedPercent, w.status === 'rejected'));
  /** The proxy may not report last use; the line is hidden then. */
  const lastUsed = () => {
    const at = c().lastUsedAt ? Date.parse(c().lastUsedAt!) : 0;
    return at ? `Used ${compactDuration(now() - at)} ago` : null;
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await window.api.usageRefresh(c().id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="account-row" classList={{ disabled: c().disabled }}>
      <div class="shrink">
        <div class="account-name">
          <ProviderGlyph provider={c().provider} />
          <span class="truncate selectable" title={c().label}>{c().label}</span>
          <Show when={c().apiKey}>
            <span class="badge">API key</span>
          </Show>
          <Show when={state() === 'next-pick'}>
            <span class="badge green" title="Picked for new conversations">Next pick</span>
          </Show>
          <Show when={!c().apiKey && LIVE_LOOKUP_PROVIDERS.has(c().provider) && !c().disabled}>
            <button class="btn ghost icon-btn" disabled={busy()} onClick={() => void refresh()} title="Refresh quota" aria-label="Refresh quota">
              <RefreshCw size={ICON_PX} class={busy() ? 'spin' : undefined} />
            </button>
          </Show>
          <Show when={c().apiKey}>
            <button class="btn ghost icon-btn" onClick={() => setPage('providers')} title="Turn on or off in AI Providers" aria-label="Manage API key">
              <Settings2 size={ICON_PX} />
            </button>
          </Show>
        </div>
        <div class="account-meta">
          <Show when={c().apiKey}>
            {(key) => <div title="Requests since the proxy started">{key().success} succeeded · {key().failed} failed</div>}
          </Show>
          <Show when={c().email && c().email !== c().label}>
            <div class="truncate">{c().email}</div>
          </Show>
          <Show when={state() === 'disabled'}>
            <div>Disabled</div>
          </Show>
          <Show when={limitedUnshown()}>
            <div class="back">Limited · <ResetTime at={c().cooldownUntil!} now={now()} /></div>
          </Show>
          <Show when={c().statusMessage && !limitedUnshown()}>
            <div class="truncate" title={c().statusMessage!}>{c().statusMessage}</div>
          </Show>
          <Show when={lastUsed()}>
            <div>{lastUsed()}</div>
          </Show>
        </div>
      </div>
      <div class="limits">
        <For each={c().windows} fallback={<span class="muted">{c().apiKey ? 'No quota reported' : 'No limit data yet — refresh to look it up.'}</span>}>
          {(w) => <LimitBar window={w} />}
        </For>
      </div>
    </div>
  );
}
