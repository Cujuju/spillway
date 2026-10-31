import { HoverTip } from './ChartTip';
import { Show } from 'solid-js';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityEvent, StoredActivityEvent } from '@shared/types';
import { conversationLabel, conversationName } from '../lib/conversationNames';
import { usd } from '../lib/format';
import { REQUEST_COLUMNS } from '../lib/requestSort';
import { shownText } from '../store';
import { MoveConversation } from './MoveConversation';
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
  const errorText = () => shownText(props.e.error ?? '');
  return (
    <>
      <tr classList={{ 'has-error': !!errorText() }}>
        <td class="tabular">{new Date(props.e.at).toLocaleTimeString()}</td>
        <td class="fill">
          <HoverTip title="Request account" layout="block" rows={[
            { label: 'Account', value: props.account(props.e.authIndex) },
            ...(props.e.model ? [{ label: 'Model', value: props.e.model }] : []),
          ]}>
          <div class="cell-name">
            <ProviderGlyph provider={props.e.provider} size="sm" />
            <span>{props.account(props.e.authIndex)} <span class="muted">· {props.e.model || '—'}</span></span>
          </div></HoverTip>
        </td>
        <td class="fill conversation-cell">
          <Show when={props.e.sessionId} fallback={<span class="muted">—</span>}>
            <div class="cell-name">
              <HoverTip title="Conversation" class="conversation-name-tip" rows={[
                ...(conversationName(props.e.sessionId!) ? [{ label: 'Name', value: conversationName(props.e.sessionId!)! }] : []),
                { label: 'ID', value: props.e.sessionId! },
              ]}><span class="conversation-name">{conversationLabel(props.e.sessionId)}</span></HoverTip>
              <Show when={props.e.movedFrom}>
                {(from) => <HoverTip title="Conversation moved" class="conversation-moved-tip" rows={[
                  { label: 'From', value: props.account(from()) },
                  { label: 'To', value: props.account(props.e.authIndex) },
                  { label: 'Prompt cache', value: 'Started over' },
                ]}><span class="badge amber">moved</span></HoverTip>}
              </Show>
              <MoveConversation e={props.e} account={props.account} />
            </div>
          </Show>
        </td>
        <td class="fill client-cell">
          <HoverTip title="Request client" rows={[
            ...(props.e.client ? [{ label: 'Client', value: props.e.client }] : []),
            ...(props.e.userAgent ? [{ label: 'User-Agent', value: props.e.userAgent }] : []),
          ]}>
          <Show when={props.e.client} fallback={<span class="muted">—</span>}>{(name) => name()}</Show></HoverTip>
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
