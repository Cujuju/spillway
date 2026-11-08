import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_OUTBOX_BYTES, CLICKHOUSE_SOURCE_LABEL_MAX, DEFAULT_CLICKHOUSE_CONFIG, type ClickHouseConfig, type ClickHouseStatus } from '@shared/clickhouse';
import { shownText } from '../store';
import { Dialog, SettingRow, SettingsGroup, Toggle } from './ui';

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const STATUS_POLL_MS = 3_000;
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;
const BACKLOG_HELP = `Up to ${CLICKHOUSE_BATCH_ROWS.toLocaleString()} rows / ${CLICKHOUSE_BATCH_BYTES / MIB} MiB per upload. Unsent rows wait in the encrypted local outbox, up to ${CLICKHOUSE_OUTBOX_BYTES / GIB} GiB; the oldest are dropped beyond that.`;

export function ClickHouseSettings() {
  const [draft, setDraft] = createSignal<ClickHouseConfig>({ ...DEFAULT_CLICKHOUSE_CONFIG });
  const [status, setStatus] = createSignal<ClickHouseStatus>();
  const [username, setUsername] = createSignal(''), [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false), [confirming, setConfirming] = createSignal(false);
  const [message, setMessage] = createSignal(''), [error, setError] = createSignal('');
  let mounted = true;
  const refresh = async () => { const value = await window.api.clickhouseStatus(); if (mounted) setStatus(value); };
  onMount(() => {
    void window.api.clickhouseStatus().then((s) => { if (mounted) { setStatus(s); setDraft(s.config); } }).catch((e) => setError(String(e)));
    const timer = setInterval(() => void refresh().catch((e) => setError(String(e))), STATUS_POLL_MS);
    onCleanup(() => { mounted = false; clearInterval(timer); setUsername(''); setPassword(''); });
  });
  const update = <K extends keyof ClickHouseConfig>(key: K, value: ClickHouseConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(''); setMessage('');
    try { await work(); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const save = (forget = false) => {
    const credentials = forget ? null : username() || password() ? { username: username(), password: password() } : undefined;
    const config = draft();
    return action(async () => {
      const result = await window.api.clickhouseSave(config, credentials);
      setUsername(''); setPassword(''); setDraft(result.config); setMessage('Settings saved.');
    });
  };
  const state = () => !status()?.config.enabled ? 'Disabled' : status()?.paused ? 'Paused' : status()?.running ? 'Uploading / checking' : status()?.backfilling ? 'Queuing retained requests' : 'Waiting';
  return <>
    <SettingsGroup title="ClickHouse destination">
      <SettingRow label="Export requests" help="Sends each request's attempts and captures to ClickHouse as they're recorded. Off by default. Save changes to apply; local Activity storage always continues.">
        <Toggle value={draft().enabled} onChange={(v) => update('enabled', v)} />
      </SettingRow>
      <SettingRow stacked label="HTTP endpoint" help="HTTP(S) origin only, e.g. https://clickhouse.example:8443. Use HTTPS to encrypt credentials and captured content in transit.">
        <input class="input wide" aria-label="ClickHouse endpoint" value={draft().endpoint} onInput={(e) => update('endpoint', e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Database"><input class="input" aria-label="ClickHouse database" value={draft().database} onInput={(e) => update('database', e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Table (schema v2)"><input class="input" aria-label="ClickHouse table" value={draft().table} onInput={(e) => update('table', e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Source label" help="Optional name for this install, sent with every row so a shared table shows who sent it. Empty sends only the random source ID.">
        <input class="input" aria-label="ClickHouse source label" maxLength={CLICKHOUSE_SOURCE_LABEL_MAX} value={draft().sourceLabel} onInput={(e) => update('sourceLabel', e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Include captured content" help="Separate opt-in. Also needs Record bodies on (Request capture). Without it, rows carry metadata only, no body text or WebSocket frames.">
        <Toggle value={draft().includeBodies} onChange={(v) => update('includeBodies', v)} />
      </SettingRow>
      <SettingRow label="Username" help={status()?.hasCredentials ? 'Credentials are saved; leave fields empty to keep them. Saved credentials never return to this view.' : 'Empty uses the ClickHouse default user without a password.'}>
        <input class="input" aria-label="ClickHouse username" autocomplete="off" value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Password"><input class="input" aria-label="ClickHouse password" type="password" autocomplete="new-password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Apply settings" help="Turning export on, or changing destination, first sends a snapshot of the requests still kept locally. Disabling pauses delivery and keeps the outbox. Clear the outbox before changing destination.">
        <button class="btn primary" disabled={busy() || !status()} onClick={() => void save()}>Save</button>
        <button class="btn" disabled={busy() || !status()?.hasCredentials} onClick={() => void save(true)}>Forget credentials</button>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Delivery">
      <SettingRow label="Connection & schema" help="Uses saved settings. Check is read-only; Create table creates schema v2 in an existing database. No database is deployed.">
        <button class="btn" disabled={busy() || !status()?.config.endpoint} onClick={() => void action(async () => setMessage(await window.api.clickhouseDiagnose(false)))}>Check</button>
        <button class="btn" disabled={busy() || !status()?.config.endpoint} onClick={() => void action(async () => setMessage(await window.api.clickhouseDiagnose(true)))}>Create table</button>
      </SettingRow>
      <SettingRow label="Upload status" help="Counts rows, not requests, task successes or billable usage. Retries can store a row twice; use FINAL or count distinct (source_id, seq) for exact counts.">
        <span class="secondary">{state()} · {status()?.acknowledged ?? 0} rows acknowledged · {status()?.discarded ?? 0} discarded ({status()?.oversized ?? 0} oversized)</span>
      </SettingRow>
      <SettingRow label="Backlog" help={`${BACKLOG_HELP} Oldest: ${status()?.oldestQueuedAt ?? 'none'}`}>
        <span class="secondary">{status()?.queued ?? 0} queued ({mib(status()?.queuedBytes ?? 0)}) · {status()?.attempts ?? 0} retries · next {status()?.nextAttemptAt ? new Date(status()!.nextAttemptAt).toLocaleString() : 'when ready'}</span>
      </SettingRow>
      <SettingRow label="Outbox controls" help="Cancel pauses until Retry, Save or restart. Clear discards unsent rows. Neither retracts remote copies; an in-flight cancelled write may already have reached the server.">
        <button class="btn" disabled={busy()} onClick={() => void action(() => window.api.clickhouseRetry())}>Retry / resume</button>
        <button class="btn" onClick={() => void window.api.clickhouseCancel().then(refresh).catch((e) => setError(String(e)))}>Cancel</button>
        <button class="btn danger" disabled={busy()} onClick={() => setConfirming(true)}>Clear outbox</button>
      </SettingRow>
      <Show when={message()}><p class="secondary" role="status">{shownText(message())}</p></Show>
      <Show when={error() || status()?.error}><p class="error" role="alert">{shownText(error() || status()?.error || '')}</p></Show>
    </SettingsGroup>
    <Show when={confirming()}><Dialog title="Discard unsent rows?" onClose={() => setConfirming(false)} actions={<>
      <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
      <button class="btn danger" onClick={() => void action(async () => { await window.api.clickhouseClear(); setConfirming(false); })}>Discard rows</button>
    </>}><p class="secondary">Local and remote data stay. Rows already sent may still commit. Re-enabling export sends a fresh snapshot of retained requests.</p></Dialog></Show>
  </>;
}
