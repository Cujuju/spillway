import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { DEFAULT_TRAY_LOOK, type TrayIconScope, type TrayIconSpec } from '@shared/settings';
import { KNOWN_WINDOW_LABELS, providerLabel, readTray, shownPercent, thresholdInUnit, trayIconText, windowLabel } from '@shared/trayValues';
import { isMac } from '../lib/platform';
import { drawTrayIcon, paintFor, TRAY_PX_2X } from '../lib/trayRender';
import { settings, snapshot, taskbarDark, updateSettings } from '../store';
import { poolRemaining } from './poolModel';
import { TrayIconLookEditor } from './TrayIconLookEditor';
import { NumberField, Seg, SettingRow, SettingsGroup, Toggle } from './ui';

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

type Draft = Omit<TrayIconSpec, 'id' | 'look'>;
const specId = (s: Draft) => [s.provider, s.windowKey, s.scope, s.credentialId].filter(Boolean).join('-');

/** Settings → Tray icons: thresholds and the list of per-limit notification-area icons with their looks. */
export function TrayIconSettings() {
  const t = () => settings().trayIcons;
  const set = (fn: (d: ReturnType<typeof settings>['trayIcons']) => void) => void updateSettings((d) => fn(d.trayIcons));
  // Thresholds follow "Number shown"; a level starts at the threshold (used: or more, remaining: or less).
  const thresholdWording = () => (t().value === 'remaining' ? 'percent remaining or less' : 'percent used or more');

  const providers = createMemo(() => {
    const seen = new Set<string>(Object.keys(FALLBACK_WINDOWS));
    for (const c of snapshot()?.credentials ?? []) seen.add(c.provider);
    return [...seen];
  });
  const [provider, setProvider] = createSignal('claude');
  const windows = createMemo(() => {
    const seen = new Map<string, { label: string; durationMs: number | null }>();
    for (const c of snapshot()?.credentials ?? []) {
      if (c.provider !== provider()) continue;
      for (const w of c.windows) if (!seen.has(w.key)) seen.set(w.key, w);
    }
    for (const key of FALLBACK_WINDOWS[provider()] ?? []) if (!seen.has(key)) seen.set(key, { label: windowLabel(key), durationMs: null });
    return [...seen]
      .sort(([, a], [, b]) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))
      .map(([key, w]) => ({ key, label: w.label }));
  });
  const [windowKey, setWindowKey] = createSignal('');
  const [scope, setScope] = createSignal<TrayIconScope>('active');
  const [credentialId, setCredentialId] = createSignal('');
  const accounts = () => (snapshot()?.credentials ?? []).filter((c) => c.provider === provider());

  const effectiveWindow = () => (windows().some((w) => w.key === windowKey()) ? windowKey() : (windows()[0]?.key ?? ''));
  const effectiveCredential = () => (accounts().some((c) => c.id === credentialId()) ? credentialId() : (accounts()[0]?.id ?? ''));
  const draft = (): Draft => ({
    provider: provider(),
    windowKey: effectiveWindow(),
    scope: scope(),
    ...(scope() === 'account' ? { credentialId: effectiveCredential() } : {}),
  });
  const duplicate = () => t().items.some((i) => i.id === specId(draft()));
  const canAdd = () => !!effectiveWindow() && (scope() !== 'account' || !!effectiveCredential()) && !duplicate();
  const add = () => {
    const spec = draft();
    set((d) => void d.items.push({ id: specId(spec), ...spec, look: DEFAULT_TRAY_LOOK }));
  };
  const move = (index: number, delta: number) =>
    set((d) => {
      const [item] = d.items.splice(index, 1);
      if (item) d.items.splice(index + delta, 0, item);
    });

  const preview = (spec: TrayIconSpec) => {
    const r = readTray(spec, snapshot(), poolRemaining);
    const text = trayIconText(shownPercent(r.usedPercent, t().value));
    return { src: drawTrayIcon(TRAY_PX_2X, text, paintFor(spec, taskbarDark())), reading: r };
  };
  const describe = (spec: TrayIconSpec) => {
    const scopeLabel = SCOPES.find((s) => s.value === spec.scope)?.label ?? spec.scope;
    const account = spec.scope === 'account' ? snapshot()?.credentials.find((c) => c.id === spec.credentialId)?.label ?? 'missing account' : null;
    return account ? `${scopeLabel} · ${account}` : scopeLabel;
  };

  return (
    <>
      <SettingsGroup title="Display">
        <SettingRow label="Show limit icons" help={SHOW_ICONS_HELP}>
          <Toggle value={t().enabled} onChange={(v) => set((d) => void (d.enabled = v))} />
        </SettingRow>
        <SettingRow label="Number shown" help="What the digits on each icon mean.">
          <Seg value={t().value} options={[{ value: 'remaining', label: '% remaining' }, { value: 'used', label: '% used' }] as const} onChange={(v) => set((d) => void (d.value = v))} />
        </SettingRow>
        <SettingRow label="Warn at" help={`Limit bars and icons turn amber at this ${thresholdWording()}.`}>
          <NumberField value={thresholdInUnit(t().warnAtPercentUsed, t().value)} unit="%" onCommit={(v) => set((d) => void (d.warnAtPercentUsed = thresholdInUnit(v, d.value)))} />
        </SettingRow>
        <SettingRow label="Critical at" help={`Limit bars and icons turn red at this ${thresholdWording()}.`}>
          <NumberField value={thresholdInUnit(t().criticalAtPercentUsed, t().value)} unit="%" onCommit={(v) => set((d) => void (d.criticalAtPercentUsed = thresholdInUnit(v, d.value)))} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Icons">
        <div class="tray-list">
          <For each={t().items} fallback={<div class="muted">No limit icons. Add one below.</div>}>
            {(spec, i) => (
              <div class="tray-item">
                <img class={taskbarDark() ? 'taskbar-dark' : 'taskbar-light'} src={preview(spec).src} width={PREVIEW_CSS_PX} height={PREVIEW_CSS_PX} alt="" />
                <div class="spacer shrink">
                  <div>{preview(spec).reading.title}</div>
                  <div class="muted truncate">{describe(spec)} · {preview(spec).reading.source}</div>
                </div>
                <button class="btn ghost icon-btn" title="Move up" disabled={i() === 0} onClick={() => move(i(), -1)}><ArrowUp size={ICON_PX} /></button>
                <button class="btn ghost icon-btn" title="Move down" disabled={i() === t().items.length - 1} onClick={() => move(i(), 1)}><ArrowDown size={ICON_PX} /></button>
                <button class="btn ghost icon-btn" title="Remove" onClick={() => set((d) => void d.items.splice(i(), 1))}><Trash2 size={ICON_PX} /></button>
                <TrayIconLookEditor
                  look={spec.look}
                  provider={spec.provider}
                  savedColors={t().savedColors}
                  onChange={(look) => {
                    const index = i();
                    set((d) => void (d.items[index]!.look = look));
                  }}
                  onSavedColorsChange={(colors) => set((d) => void (d.savedColors = colors))}
                />
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
      </SettingsGroup>
    </>
  );
}
