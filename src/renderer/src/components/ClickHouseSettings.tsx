import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { DEFAULT_CLICKHOUSE_CONFIG, type ClickHouseConfig, type ClickHouseStatus } from '@shared/clickhouse';
import { shownText } from '../store';
import { Dialog, SettingRow, SettingsGroup, Toggle } from './ui';

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
    const timer = setInterval(() => void refresh().catch((e) => setError(String(e))), 3_000);
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
  return <>
    <SettingsGroup title="ClickHouse destination">
      <SettingRow label="Export request archive" help="Optional copy of locally retained requests. Off by default. Save changes to apply; local Activity storage always continues.">
        <Toggle value={draft().enabled} onChange={(v) => update('enabled', v)} />
      </SettingRow>
      <SettingRow stacked label="HTTP endpoint" help="HTTP(S) origin only, e.g. https://clickhouse.example:8443. Use HTTPS to encrypt credentials and captured content in transit.">
        <input class="input wide" aria-label="ClickHouse endpoint" value={draft().endpoint} onInput={(e) => update('endpoint', e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Database"><input class="input" aria-label="ClickHouse database" value={draft().database} onInput={(e) => update('database', e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Table (schema v1)"><input class="input" aria-label="ClickHouse table" value={draft().table} onInput={(e) => update('table', e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Include captured content" help="Independent opt-in. Also requires archive body capture to be enabled and content to remain available. Metadata-only exports omit body text and WS frames.">
        <Toggle value={draft().includeBodies} onChange={(v) => update('includeBodies', v)} />
      </SettingRow>
      <SettingRow label="Username" help={status()?.hasCredentials ? 'Credentials are saved; leave fields empty to keep them. Saved credentials never return to this view.' : 'Empty uses the ClickHouse default user without a password.'}>
        <input class="input" aria-label="ClickHouse username" autocomplete="off" value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
      </SettingRow>
      <SettingRow label="Password"><input class="input" aria-label="ClickHouse password" type="password" autocomplete="new-password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} /></SettingRow>
      <SettingRow label="Apply settings" help="Disabling pauses delivery and keeps the queue. Clear the queue before changing destination. Re-enabling queues currently retained entries.">
        <button class="btn primary" disabled={busy() || !status()} onClick={() => void save()}>Save</button>
        <button class="btn" disabled={busy() || !status()?.hasCredentials} onClick={() => void save(true)}>Forget credentials</button>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Delivery">
      <SettingRow label="Connection & schema" help="Uses saved settings. Check is read-only; Create table creates schema v1 in an existing database. No database is deployed.">
        <button class="btn" disabled={busy() || !status()?.config.endpoint} onClick={() => void action(async () => setMessage(await window.api.clickhouseDiagnose(false)))}>Check</button>
        <button class="btn" disabled={busy() || !status()?.config.endpoint} onClick={() => void action(async () => setMessage(await window.api.clickhouseDiagnose(true)))}>Create table</button>
      </SettingRow>
      <SettingRow label="Upload status" help="Acknowledgments count delivered revisions, never task successes or billable requests. Queries must use FINAL to remove retry duplicates and superseded revisions.">
        <span class="secondary">{!status()?.config.enabled ? 'Disabled' : status()?.paused ? 'Paused' : status()?.running ? 'Uploading / checking' : 'Waiting'} · {status()?.queued ?? 0} queued · {status()?.acknowledged ?? 0} revisions acknowledged · {status()?.discarded ?? 0} discarded ({status()?.oversized ?? 0} oversized)</span>
      </SettingRow>
      <SettingRow label="Backlog" help={`One batch is capped at 32 records / 8 MiB; the reference queue is capped at 20,000 records. Oldest: ${status()?.oldestQueuedAt ?? 'none'}`}>
        <span class="secondary">{status()?.batchBytes ?? 0} batch bytes · {status()?.attempts ?? 0} retries · next {status()?.nextAttemptAt ? new Date(status()!.nextAttemptAt).toLocaleString() : 'when ready'}</span>
      </SettingRow>
      <SettingRow label="Queue controls" help="Cancel pauses until Retry, Save or restart. Clear discards unsent work; later revisions can queue again. Clear/expiry never retract remote copies; an in-flight cancelled write may already have reached the server.">
        <button class="btn" disabled={busy()} onClick={() => void action(() => window.api.clickhouseRetry())}>Retry / resume</button>
        <button class="btn" onClick={() => void window.api.clickhouseCancel().then(refresh).catch((e) => setError(String(e)))}>Cancel</button>
        <button class="btn danger" disabled={busy()} onClick={() => setConfirming(true)}>Clear queue</button>
      </SettingRow>
      <Show when={message()}><p class="secondary" role="status">{shownText(message())}</p></Show>
      <Show when={error() || status()?.error}><p class="error" role="alert">{shownText(error() || status()?.error || '')}</p></Show>
    </SettingsGroup>
    <Show when={confirming()}><Dialog title="Discard queued uploads?" onClose={() => setConfirming(false)} actions={<>
      <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
      <button class="btn danger" onClick={() => void action(async () => { await window.api.clickhouseClear(); setConfirming(false); })}>Discard queue</button>
    </>}><p class="secondary">Local archive data stays. Remote data stays. Already-sent requests may still commit. Retained entries queue again when export is re-enabled.</p></Dialog></Show>
  </>;
}
