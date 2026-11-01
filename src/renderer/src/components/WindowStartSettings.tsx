import { createResource, For, Show } from 'solid-js';
import { cheapestModel } from '@shared/modelPrices';
import type { AppSettings } from '@shared/settings';
import { providerLabel } from '@shared/trayValues';
import { minuteToTime, timeToMinute, WINDOW_START_PROVIDERS, type WindowStartProvider } from '@shared/windowStartSettings';
import { settings, snapshot, updateSettings } from '../store';
import { Seg, SettingRow, SettingsGroup, Toggle } from './ui';

const set = (fn: (d: AppSettings) => void) => void updateSettings(fn);

const SPACING = [
  { value: false, label: 'All at once', help: 'Every idle account starts its window as soon as it resets.' },
  { value: true, label: 'Spaced out', help: 'Space each provider’s account starts evenly across a window, so one always resets soon.' },
] as const;

/** Model ids any of the provider's subscription logins offers. */
function ModelPicker(props: { provider: WindowStartProvider }) {
  const ids = () => (snapshot()?.credentials ?? []).filter((c) => c.provider === props.provider && !c.apiKey).map((c) => c.id);
  const [models] = createResource(ids, async (list) => {
    const lists = await Promise.all(list.map((id) => window.api.credentialModels(id).catch(() => [])));
    return [...new Set(lists.flat().map((m) => m.id))].sort();
  });
  const auto = () => cheapestModel(models() ?? []);
  return (
    <select
      class="select"
      value={settings().windowStart.models[props.provider]}
      onChange={(e) => set((d) => void (d.windowStart.models[props.provider] = e.currentTarget.value))}
    >
      <option value="">{auto() ? `Cheapest (${auto()})` : 'Cheapest'}</option>
      <For each={models() ?? []}>{(id) => <option value={id}>{id}</option>}</For>
    </select>
  );
}

function TimeField(props: { value: number; onCommit: (minute: number) => void }) {
  return (
    <input
      class="input tabular"
      type="time"
      value={minuteToTime(props.value)}
      onChange={(e) => {
        const minute = timeToMinute(e.currentTarget.value);
        if (minute !== null) props.onCommit(minute);
      }}
    />
  );
}

/** Settings → Window starts: start each account's 5-hour window as soon as it resets. */
export function WindowStartSettings() {
  const ws = () => settings().windowStart;
  const [status] = createResource(() => window.api.windowStartStatus());
  const label = (id: string) => snapshot()?.credentials.find((c) => c.id === id)?.label ?? id;
  return (
    <>
      <SettingsGroup>
        <SettingRow
          label="Start windows at reset"
          help="A 5-hour window starts at an account's first request. On reset, send a one-word request so the next window starts at once and resets sooner. Weekly limits are unaffected."
        >
          <Toggle value={ws().enabled} onChange={(v) => set((d) => void (d.windowStart.enabled = v))} />
        </SettingRow>
        <Show when={status()?.lastError}>
          {(e) => <p class="list-row-help error">{label(e().credentialId)}: {e().message}</p>}
        </Show>
        <Show when={status()?.lastStart}>
          {(s) => <p class="list-row-help muted">Last started {label(s().credentialId)} with {s().model} at {new Date(s().at).toLocaleTimeString()}.</p>}
        </Show>
      </SettingsGroup>
      <SettingsGroup title="Model">
        <For each={WINDOW_START_PROVIDERS}>
          {(provider) => (
            <SettingRow label={providerLabel(provider)} help="Cheapest picks the lowest-priced model each account offers.">
              <ModelPicker provider={provider} />
            </SettingRow>
          )}
        </For>
      </SettingsGroup>
      <SettingsGroup title="Timing">
        <SettingRow label="Several accounts" help={SPACING.find((s) => s.value === ws().stagger)?.help}>
          <Seg
            value={ws().stagger ? 'spaced' : 'together'}
            options={[{ value: 'together', label: SPACING[0].label }, { value: 'spaced', label: SPACING[1].label }] as const}
            onChange={(v) => set((d) => void (d.windowStart.stagger = v === 'spaced'))}
          />
        </SettingRow>
        <SettingRow label="Only during set hours" help="Outside these local hours, starts wait until they begin. An end before the start runs past midnight.">
          <Toggle value={ws().activeHours.enabled} onChange={(v) => set((d) => void (d.windowStart.activeHours.enabled = v))} />
        </SettingRow>
        <Show when={ws().activeHours.enabled}>
          <SettingRow nested label="From">
            <TimeField value={ws().activeHours.startMinute} onCommit={(m) => set((d) => void (d.windowStart.activeHours.startMinute = m))} />
          </SettingRow>
          <SettingRow nested label="Until">
            <TimeField value={ws().activeHours.endMinute} onCommit={(m) => set((d) => void (d.windowStart.activeHours.endMinute = m))} />
          </SettingRow>
        </Show>
      </SettingsGroup>
    </>
  );
}
