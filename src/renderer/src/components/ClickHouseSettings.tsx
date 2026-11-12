import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_OUTBOX_BYTES, CLICKHOUSE_SOURCE_LABEL_MAX, CLICKHOUSE_TABLES_MISSING, DEFAULT_CLICKHOUSE_CONFIG, type ClickHouseConfig, type ClickHouseStatus } from '@shared/clickhouse';
import { shownText } from '../store';
import { Dialog, SettingRow, SettingsGroup, Toggle } from './ui';

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const STATUS_POLL_MS = 3_000;
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;
const when = (at: string | number | null | undefined) => at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
// Saved credentials never return to the renderer; masked placeholder marks them saved.
const SAVED_CREDENTIAL_PLACEHOLDER = '••••••••';
const SENT_TIP = 'Counts rows, not requests. Retries can store a row twice; use FINAL or distinct (source_id, seq).';
const QUEUED_TIP = `Uploads up to ${CLICKHOUSE_BATCH_ROWS.toLocaleString()} rows / ${CLICKHOUSE_BATCH_BYTES / MIB} MiB at a time. The encrypted outbox holds up to ${CLICKHOUSE_OUTBOX_BYTES / GIB} GiB, then drops the oldest.`;
const EXPIRED_TIP = 'Text removed locally (Keep bodies or Body budget) before upload; sent as metadata only.';

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
  const unsaved = () => { const saved = status()?.config; return !!saved && (JSON.stringify({ ...saved, sourceLabel: saved.sourceLabel.trim() }) !== JSON.stringify({ ...draft(), sourceLabel: draft().sourceLabel.trim() }) || !!username() || !!password()); };
  const savedPlaceholder = () => status()?.hasCredentials ? SAVED_CREDENTIAL_PLACEHOLDER : '';
  const state = () => !status()?.config.enabled ? 'Off' : status()?.paused ? 'Paused' : status()?.running ? 'Uploading' : status()?.backfilling ? 'Queuing' : 'Idle';
  const problem = () => error() || status()?.error || '';
  const tablesMissing = () => problem().includes(CLICKHOUSE_TABLES_MISSING);
  return <>
    <SettingsGroup title="ClickHouse destination">
      <SettingRow label="Export requests" help="Sends each request's metadata to ClickHouse. Local Activity is unaffected.">
        <Toggle value={draft().enabled} onChange={(v) => update('enabled', v)} />
      </SettingRow>
      <SettingRow label="Include captured content" help="Also sends request and response text. Needs Record bodies (Request capture).">
        <Toggle value={draft().includeBodies} onChange={(v) => update('includeBodies', v)} />
      </SettingRow>
      <SettingRow label="HTTP endpoint" help="Origin only, e.g. https://clickhouse.example:8443. HTTPS encrypts login and content.">
        <input class="input origin-field" aria-label="ClickHouse endpoint" value={draft().endpoint} onInput={(e) => update('endpoint', e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Database"><input class="input" aria-label="ClickHouse database" value={draft().database} onInput={(e) => update('database', e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Table prefix (schema v1)" help={`Writes ${draft().tablePrefix || '<prefix>'}_facts and ${draft().tablePrefix || '<prefix>'}_pieces.`}>
        <input class="input" aria-label="ClickHouse table prefix" value={draft().tablePrefix} onInput={(e) => update('tablePrefix', e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Source label" help="Optional. Names this install on every row.">
        <input class="input" aria-label="ClickHouse source label" maxLength={CLICKHOUSE_SOURCE_LABEL_MAX} value={draft().sourceLabel} onInput={(e) => update('sourceLabel', e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Username" help={status()?.hasCredentials ? 'ClickHouse server login. Saved; type to replace.' : 'ClickHouse server login. Blank uses the default user.'}>
        <input class="input" aria-label="ClickHouse username" autocomplete="off" placeholder={savedPlaceholder()} value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Password"><input class="input" aria-label="ClickHouse password" type="password" autocomplete="new-password" placeholder={savedPlaceholder()} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Apply" help="Enabling or a new destination first uploads stored requests. Clear the outbox before changing destination.">
        <Show when={unsaved()}><span class="secondary" role="status">Unsaved changes</span></Show>
        <button class="btn primary" disabled={busy() || !unsaved()} onClick={() => void save()}>Save</button>
        <button class="btn" disabled={busy() || !status()?.hasCredentials} onClick={() => void save(true)}>Forget credentials</button>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Delivery">
      <div class="stat-strip inset">
        <div class="stat-cell"><div class="stat-label">Status</div><div class="stat-value">{state()}</div><div class="stat-sub">{status()?.backfilling ? 'adding stored requests' : status()?.config.enabled ? 'export on' : 'export off'}</div></div>
        <div class="stat-cell" title={SENT_TIP}><div class="stat-label">Sent</div><div class="stat-value">{(status()?.acknowledged ?? 0).toLocaleString()}</div><div class="stat-sub">{status()?.lastAcknowledgedAt ? `last ${when(status()?.lastAcknowledgedAt)}` : 'rows'}</div></div>
        <div class="stat-cell" title={QUEUED_TIP}><div class="stat-label">Queued</div><div class="stat-value">{(status()?.queued ?? 0).toLocaleString()}</div><div class="stat-sub">{mib(status()?.queuedBytes ?? 0)}{status()?.oldestQueuedAt ? ` · since ${when(status()?.oldestQueuedAt)}` : ''}</div></div>
        <div class="stat-cell"><div class="stat-label">Retries</div><div class="stat-value" classList={{ 'danger-text': !!status()?.attempts }}>{status()?.attempts ?? 0}</div><div class="stat-sub">{status()?.nextAttemptAt ? `next ${when(status()?.nextAttemptAt)}` : 'none pending'}</div></div>
        <div class="stat-cell"><div class="stat-label">Discarded</div><div class="stat-value" classList={{ 'danger-text': !!status()?.discarded }}>{(status()?.discarded ?? 0).toLocaleString()}</div><div class="stat-sub">{status()?.oversized ?? 0} oversized</div></div>
        <Show when={status()?.contentExpired}>{(n) => (
          <div class="stat-cell" title={EXPIRED_TIP}><div class="stat-label">No content</div><div class="stat-value">{n().toLocaleString()}</div><div class="stat-sub">text expired first</div></div>
        )}</Show>
      </div>
      <SettingRow label="Connection" help={tablesMissing() ? 'Tables not found. Create them in the saved database.' : 'Tests the saved login, database and tables.'}>
        <Show when={tablesMissing()} fallback={
          <button class="btn" disabled={busy() || !status()?.config.endpoint} onClick={() => void action(async () => setMessage(await window.api.clickhouseDiagnose(false)))}>Check</button>
        }>
          <button class="btn primary" disabled={busy()} onClick={() => void action(async () => setMessage(await window.api.clickhouseDiagnose(true)))}>Create tables</button>
        </Show>
      </SettingRow>
      <SettingRow label="Outbox" help="Cancel pauses until Retry, Save or restart. Clear discards unsent rows; sent rows stay.">
        <button class="btn" disabled={busy()} onClick={() => void action(() => window.api.clickhouseRetry())}>Retry / resume</button>
        <button class="btn" onClick={() => void window.api.clickhouseCancel().then(refresh).catch((e) => setError(String(e)))}>Cancel</button>
        <button class="btn danger" disabled={busy()} onClick={() => setConfirming(true)}>Clear outbox</button>
      </SettingRow>
      <Show when={message()}><p class="notice info" role="status">{shownText(message())}</p></Show>
      <Show when={problem()}><p class="notice error" role="alert">{shownText(problem())}</p></Show>
    </SettingsGroup>
    <Show when={confirming()}><Dialog title="Discard unsent rows?" onClose={() => setConfirming(false)} actions={<>
      <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
      <button class="btn danger" onClick={() => void action(async () => { await window.api.clickhouseClear(); setConfirming(false); })}>Discard rows</button>
    </>}><p class="secondary">Local and remote data stay. Rows already sent may still commit. Re-enabling export sends a fresh snapshot of retained requests.</p></Dialog></Show>
  </>;
}
