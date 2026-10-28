import { Show } from 'solid-js';
import { tokenCost } from '@shared/modelPrices';
import { maskEmails } from '@shared/privacy';
import type { ActivityEvent, StoredActivityEvent } from '@shared/types';
import { conversationLabel, conversationName } from '../lib/conversationNames';
import { usd } from '../lib/format';
import { REQUEST_COLUMNS } from '../lib/requestSort';
import { settings } from '../store';
import { TokenCell } from './TokenCell';
import { ProviderGlyph } from './ui';

const MS_PER_SECOND = 1000;
/** Below this, show milliseconds; above, seconds with one decimal. */
const SHOW_SECONDS_FROM_MS = 1000;
export const REQUEST_COLUMN_COUNT = REQUEST_COLUMNS.length;

const duration = (ms: number | null) => (ms === null ? '—' : ms < SHOW_SECONDS_FROM_MS ? `${ms} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} s`);
const requestCost = (e: ActivityEvent) => {
  const cost = tokenCost(e.provider, e.model, e);
  return cost ? usd(cost.usd) : '—';
};

/** One attempt; cells follow REQUEST_COLUMNS. A failure's error gets its own line so it never widens the columns. */
export function RequestRow(props: { e: StoredActivityEvent; account: (authIndex: string | null) => string }) {
  const errorText = () => {
    const text = props.e.error ?? '';
    return settings().dashboard.showEmails ? text : maskEmails(text);
  };
  /** The title (when known) and the full ID the proxy keys the conversation by. */
  const conversationTitle = () => {
    const id = props.e.sessionId;
    return id ? [conversationName(id), id].filter(Boolean).join('\n') : undefined;
  };
  return (
    <>
      <tr classList={{ 'has-error': !!errorText() }}>
        <td class="tabular">{new Date(props.e.at).toLocaleTimeString()}</td>
        <td class="fill" title={`${props.account(props.e.authIndex)} · ${props.e.model || 'no model'}`}>
          <div class="cell-name">
            <ProviderGlyph provider={props.e.provider} size="sm" />
            <span>{props.account(props.e.authIndex)} <span class="muted">· {props.e.model || '—'}</span></span>
          </div>
        </td>
        <td class="fill conversation-cell" title={conversationTitle()}>
          <Show when={props.e.sessionId} fallback={<span class="muted">—</span>}>
            <div class="cell-name">
              <span>{conversationLabel(props.e.sessionId)}</span>
              <Show when={props.e.movedFrom}>
                {(from) => <span class="badge amber" title={`Moved from ${props.account(from())}; the prompt cache started over`}>moved</span>}
              </Show>
            </div>
          </Show>
        </td>
        <td>
          <Show when={props.e.failed} fallback={<span class="badge green">OK</span>}>
            <span class="badge red">{props.e.statusCode ?? 'Failed'}</span>
          </Show>
        </td>
        <TokenCell v={props.e.inputTokens} />
        <TokenCell v={props.e.outputTokens} />
        <TokenCell v={props.e.cachedTokens} />
        <TokenCell v={props.e.cacheWriteTokens} provider={props.e.provider} />
        <td class="tabular num">{requestCost(props.e)}</td>
        <td class="tabular num">{duration(props.e.ttftMs)}</td>
        <td class="tabular num">{duration(props.e.latencyMs)}</td>
      </tr>
      <Show when={errorText()}>
        <tr class="error-row">
          <td colSpan={REQUEST_COLUMN_COUNT}><div class="truncate" title={errorText()}>{errorText()}</div></td>
        </tr>
      </Show>
    </>
  );
}
