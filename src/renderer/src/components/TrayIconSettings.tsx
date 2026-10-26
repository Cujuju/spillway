import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { TrayIconScope, TrayIconSpec } from '@shared/settings';
import { KNOWN_WINDOW_LABELS, providerLabel, readTray, trayLevel, windowLabel } from '@shared/trayValues';
import { windowPeriodMs } from '../lib/forecast';
import { isMac } from '../lib/platform';
import { providerColor } from '../lib/providers';
import { drawTrayIcon, TRAY_PX_2X } from '../lib/trayRender';
import { settings, snapshot, taskbarDark, updateSettings } from '../store';
import { NumberField, Seg, SettingRow, Toggle } from './ui';

const ICON_PX = 14;
/** Preview at 2x so the tile is legible in the settings list. */
const PREVIEW_CSS_PX = 24;
/** Offered before the proxy has reported any windows, so first-run setup still works. */
const FALLBACK_WINDOWS: Record<string, string[]> = { claude: Object.keys(KNOWN_WINDOW_LABELS) };
const SHOW_ICONS_HELP = isMac
  ? 'One menu bar icon per entry below. Cmd-drag an icon to reorder it.'
  : 'One notification-area icon per entry below. Windows may hide new icons in the overflow (^) menu; drag them onto the taskbar to keep them visible.';

const SCOPES: { value: TrayIconScope; label: string; title: string }[] = [
  { value: 'active', label: 'Active account', title: 'The account the proxy picks next' },
  { value: 'pool', label: 'Pool average', title: 'Average across enabled accounts; 100% used means all are out' },
  { value: 'lowest', label: 'Least left', title: 'The most used enabled account' },
  { value: 'account', label: 'One account', title: 'A specific account' },
];

const specId = (s: Omit<TrayIconSpec, 'id'>) => [s.provider, s.windowKey, s.scope, s.credentialId].filter(Boolean).join('-');

/** Settings → Tray icons: thresholds and the list of per-limit notification-area icons. */
export function TrayIconSettings() {
  const t = () => settings().trayIcons;
  const set = (fn: (d: ReturnType<typeof settings>['trayIcons']) => void) => void updateSettings((d) => fn(d.trayIcons));

  const providers = createMemo(() => {
    const seen = new Set<string>(Object.keys(FALLBACK_WINDOWS));
    for (const c of snapshot()?.credentials ?? []) seen.add(c.provider);
    return [...seen];
  });
  const [provider, setProvider] = createSignal('claude');
  const windows = createMemo(() => {
    const seen = new Map<string, string>();
    for (const c of snapshot()?.credentials ?? []) {
      if (c.provider !== provider()) continue;
      for (const w of c.windows) if (!seen.has(w.key)) seen.set(w.key, w.label);
    }
    for (const key of FALLBACK_WINDOWS[provider()] ?? []) if (!seen.has(key)) seen.set(key, windowLabel(key));
    return [...seen].map(([key, label]) => ({ key, label })).sort((a, b) => (windowPeriodMs(a.key) ?? Infinity) - (windowPeriodMs(b.key) ?? Infinity));
  });
  const [windowKey, setWindowKey] = createSignal('');
  const [scope, setScope] = createSignal<TrayIconScope>('active');
  const [credentialId, setCredentialId] = createSignal('');
  const accounts = () => (snapshot()?.credentials ?? []).filter((c) => c.provider === provider());

  const effectiveWindow = () => (windows().some((w) => w.key === windowKey()) ? windowKey() : (windows()[0]?.key ?? ''));
  const effectiveCredential = () => (accounts().some((c) => c.id === credentialId()) ? credentialId() : (accounts()[0]?.id ?? ''));
  const draft = (): Omit<TrayIconSpec, 'id'> => ({
    provider: provider(),
    windowKey: effectiveWindow(),
    scope: scope(),
    ...(scope() === 'account' ? { credentialId: effectiveCredential() } : {}),
  });
  const duplicate = () => t().items.some((i) => i.id === specId(draft()));
  const canAdd = () => !!effectiveWindow() && (scope() !== 'account' || !!effectiveCredential()) && !duplicate();
  const add = () => set((d) => void d.items.push({ id: specId(draft()), ...draft() }));
  const move = (index: number, delta: number) =>
    set((d) => {
      const [item] = d.items.splice(index, 1);
      if (item) d.items.splice(index + delta, 0, item);
    });

  const preview = (spec: TrayIconSpec) => {
    const r = readTray(spec, snapshot());
    const shown = r.usedPercent === null ? null : t().value === 'remaining' ? 100 - r.usedPercent : r.usedPercent;
    const level = trayLevel(r.usedPercent, t().warnAtPercentUsed, t().criticalAtPercentUsed);
    const look = { level, providerColor: providerColor(spec.provider), darkTaskbar: taskbarDark() };
    return { src: drawTrayIcon(TRAY_PX_2X, shown === null ? '–' : String(Math.round(Math.max(0, shown))), look), reading: r };
  };
  const describe = (spec: TrayIconSpec) => {
    const scopeLabel = SCOPES.find((s) => s.value === spec.scope)?.label ?? spec.scope;
    const account = spec.scope === 'account' ? snapshot()?.credentials.find((c) => c.id === spec.credentialId)?.label ?? 'missing account' : null;
    return account ? `${scopeLabel} · ${account}` : scopeLabel;
  };

  return (
    <>
      <SettingRow label="Show limit icons" help={SHOW_ICONS_HELP}>
        <Toggle value={t().enabled} onChange={(v) => set((d) => void (d.enabled = v))} />
      </SettingRow>
      <SettingRow label="Number shown" help="What the digits on each icon mean.">
        <Seg value={t().value} options={[{ value: 'remaining', label: '% remaining' }, { value: 'used', label: '% used' }] as const} onChange={(v) => set((d) => void (d.value = v))} />
      </SettingRow>
      <SettingRow label="Warn at" help="Icon turns amber at this percent used.">
        <NumberField value={t().warnAtPercentUsed} suffix="% used" onCommit={(v) => set((d) => void (d.warnAtPercentUsed = v))} />
      </SettingRow>
      <SettingRow label="Critical at" help="Icon turns red at this percent used.">
        <NumberField value={t().criticalAtPercentUsed} suffix="% used" onCommit={(v) => set((d) => void (d.criticalAtPercentUsed = v))} />
      </SettingRow>

      <div class="section-label" style={{ 'margin-top': '18px' }}>Icons</div>
      <div class="tray-list">
        <For each={t().items} fallback={<div class="muted">No limit icons. Add one below.</div>}>
          {(spec, i) => (
            <div class="tray-item">
              <img class={taskbarDark() ? 'taskbar-dark' : 'taskbar-light'} src={preview(spec).src} width={PREVIEW_CSS_PX} height={PREVIEW_CSS_PX} alt="" />
              <div class="spacer" style={{ 'min-width': 0 }}>
                <div>{preview(spec).reading.title}</div>
                <div class="muted truncate">{describe(spec)} · {preview(spec).reading.source}</div>
              </div>
              <button class="btn ghost icon-btn" title="Move up" disabled={i() === 0} onClick={() => move(i(), -1)}><ArrowUp size={ICON_PX} /></button>
              <button class="btn ghost icon-btn" title="Move down" disabled={i() === t().items.length - 1} onClick={() => move(i(), 1)}><ArrowDown size={ICON_PX} /></button>
              <button class="btn ghost icon-btn" title="Remove" onClick={() => set((d) => void d.items.splice(i(), 1))}><Trash2 size={ICON_PX} /></button>
            </div>
          )}
        </For>
      </div>

      <div class="tray-add">
        <select class="select" value={provider()} onChange={(e) => setProvider(e.currentTarget.value)}>
          <For each={providers()}>{(p) => <option value={p}>{providerLabel(p)}</option>}</For>
        </select>
        <select class="select" value={effectiveWindow()} onChange={(e) => setWindowKey(e.currentTarget.value)}>
          <For each={windows()} fallback={<option value="">No limits reported yet</option>}>{(w) => <option value={w.key}>{w.label}</option>}</For>
        </select>
        <select class="select" value={scope()} onChange={(e) => setScope(e.currentTarget.value as TrayIconScope)}>
          <For each={SCOPES}>{(s) => <option value={s.value} title={s.title}>{s.label}</option>}</For>
        </select>
        <Show when={scope() === 'account'}>
          <select class="select" value={effectiveCredential()} onChange={(e) => setCredentialId(e.currentTarget.value)}>
            <For each={accounts()} fallback={<option value="">No accounts</option>}>{(c) => <option value={c.id}>{c.label}</option>}</For>
          </select>
        </Show>
        <button class="btn primary" disabled={!canAdd()} title={duplicate() ? 'Already added' : undefined} onClick={add}>
          <Plus size={ICON_PX} /> Add icon
        </button>
      </div>
    </>
  );
}
