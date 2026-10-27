import { RefreshCw } from 'lucide-solid';
import { createSignal, For, Show } from 'solid-js';
import { resetText } from '@shared/resetTime';
import type { Credential } from '@shared/types';
import { compactDuration } from '../lib/format';
import { now } from '../store';
import { LimitBar } from './LimitBar';
import { ProviderGlyph } from './ui';

const ICON_PX = 13;
/** The proxy's on-demand usage lookup (POST /usage/refresh) supports Claude OAuth accounts only. */
const LIVE_LOOKUP_PROVIDER = 'claude';

/** One account in Theo's list: name + state, limit bars, refresh. */
export function AccountRow(props: { credential: Credential }) {
  const c = () => props.credential;
  const [busy, setBusy] = createSignal(false);
  const benchedFor = () => {
    const until = c().cooldownUntil ? Date.parse(c().cooldownUntil!) : 0;
    return until > now() ? until - now() : 0;
  };
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
      <div style={{ 'min-width': 0 }}>
        <div class="account-name">
          <ProviderGlyph provider={c().provider} />
          <span class="truncate selectable" title={c().label}>{c().label}</span>
          <Show when={!c().disabled && benchedFor() === 0 && c().nextPick}>
            <span class="badge green" title="Picked for new conversations">Next pick</span>
          </Show>
        </div>
        <div class="account-meta">
          <Show when={c().email && c().email !== c().label}>
            <div class="truncate">{c().email}</div>
          </Show>
          <Show when={c().disabled}>
            <div>Disabled</div>
          </Show>
          <Show when={!c().disabled && benchedFor() > 0}>
            <div class="back">Limited · back {resetText(c().cooldownUntil!, now())}</div>
          </Show>
          <Show when={c().statusMessage && benchedFor() === 0}>
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
      <div class="account-actions">
        <Show when={c().provider === LIVE_LOOKUP_PROVIDER && !c().disabled}>
          <button class="btn ghost" disabled={busy()} onClick={refresh} title="Look up this account's limits now">
            <RefreshCw size={ICON_PX} class={busy() ? 'spin' : undefined} /> Refresh quota
          </button>
        </Show>
      </div>
    </div>
  );
}
