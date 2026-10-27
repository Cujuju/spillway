import { RefreshCw } from 'lucide-solid';
import { createSignal, For, Show } from 'solid-js';
import { accountState } from '@shared/accountState';
import type { Credential } from '@shared/types';
import { compactDuration } from '../lib/format';
import { now } from '../store';
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
          <Show when={state() === 'next-pick'}>
            <span class="badge green" title="Picked for new conversations">Next pick</span>
          </Show>
          <Show when={LIVE_LOOKUP_PROVIDERS.has(c().provider) && !c().disabled}>
            <button class="btn ghost icon-btn" disabled={busy()} onClick={() => void refresh()} title="Refresh quota" aria-label="Refresh quota">
              <RefreshCw size={ICON_PX} class={busy() ? 'spin' : undefined} />
            </button>
          </Show>
        </div>
        <div class="account-meta">
          <Show when={c().email && c().email !== c().label}>
            <div class="truncate">{c().email}</div>
          </Show>
          <Show when={state() === 'disabled'}>
            <div>Disabled</div>
          </Show>
          <Show when={state() === 'limited'}>
            <div class="back">Limited · <ResetTime at={c().cooldownUntil!} now={now()} /></div>
          </Show>
          <Show when={c().statusMessage && state() !== 'limited'}>
            <div class="truncate" title={c().statusMessage!}>{c().statusMessage}</div>
          </Show>
          <Show when={lastUsed()}>
            <div>{lastUsed()}</div>
          </Show>
        </div>
      </div>
      <div class="limits">
        <For each={c().windows} fallback={<span class="muted">No limit data yet — refresh to look it up.</span>}>
          {(w) => <LimitBar window={w} />}
        </For>
      </div>
    </div>
  );
}
