import { For, Show } from 'solid-js';
import { Plus, X } from 'lucide-solid';
import { CANARY_INTERVALS, CANARY_MAX_TARGETS, CANARY_PROBES, type CanaryTarget } from '@shared/canary';
import type { AppSettings } from '@shared/settings';
import { settings, updateSettings } from '../store';
import { CANARY_COLORS } from '../lib/canaryView';
import { Seg, Select, Toggle } from './ui';
import { appLocale } from '@shared/timeFormat';

const ICON_PX = 14;
const HOURS_PER_DAY = 24;
/** Efforts the proxy maps for Claude and OpenAI reasoning models. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEFAULT_EFFORT = 'high';
const set = (fn: (d: AppSettings) => void) => void updateSettings(fn);

/** Enable, schedule and targets for canary probes. `models` are the ones seen in Activity, offered first. */
export function CanarySetup(props: { models: string[] }) {
  const canary = () => settings().canary;
  const callsPerDay = () => canary().targets.length * CANARY_PROBES.length * (HOURS_PER_DAY / canary().intervalHours);
  const modelOptions = (current: string) => [...new Set([current, ...props.models].filter(Boolean))].sort().map((m) => ({ value: m, label: m }));
  const update = (i: number, patch: Partial<CanaryTarget>) => set((d) => void Object.assign(d.canary.targets[i]!, patch));
  const add = () => {
    const models = props.models;
    set((d) => void d.canary.targets.push({ model: models.find((m) => !d.canary.targets.some((t) => t.model === m)) ?? models[0] ?? '', effort: DEFAULT_EFFORT }));
  };

  return (
    <div class="canary-setup">
      <div class="canary-setup-row">
        <div class="canary-setup-label">
          <span>Run probes</span>
          <span class="muted">Sends {CANARY_PROBES.length} short reasoning problems with known answers to each target, through the proxy. They use your accounts’ quota and stay out of Activity.</span>
        </div>
        <Toggle label="Run canary probes" value={canary().enabled} onChange={(v) => set((d) => void (d.canary.enabled = v))} />
      </div>
      <div class="canary-setup-row">
        <div class="canary-setup-label"><span>Every</span></div>
        <Seg label="Interval" value={canary().intervalHours} options={CANARY_INTERVALS.map((h) => ({ value: h, label: `${h} h` }))} onChange={(h) => set((d) => void (d.canary.intervalHours = h))} />
      </div>
      <div class="canary-targets">
        <For each={canary().targets} fallback={<p class="muted">Add a model and effort to probe. Pick the ones you rely on most.</p>}>
          {(t, i) => (
            <div class="canary-target">
              <span class="canary-swatch" style={{ background: CANARY_COLORS[i() % CANARY_COLORS.length] }} />
              <Select label="Model" value={t.model} options={modelOptions(t.model)} onChange={(model) => update(i(), { model })} />
              <Select label="Effort" value={t.effort} options={EFFORTS.map((e) => ({ value: e, label: e }))} onChange={(effort) => update(i(), { effort })} />
              <button class="btn icon-btn ghost" type="button" title="Remove target" aria-label={`Remove ${t.model} ${t.effort}`} onClick={() => set((d) => void d.canary.targets.splice(i(), 1))}><X size={ICON_PX} /></button>
            </div>
          )}
        </For>
        <div class="canary-targets-foot">
          <button class="btn ghost" type="button" disabled={canary().targets.length >= CANARY_MAX_TARGETS || !props.models.length} onClick={add}><Plus size={ICON_PX} />Add target</button>
          <Show when={canary().targets.length}>
            <span class="muted">{callsPerDay().toLocaleString(appLocale())} calls a day</span>
          </Show>
        </div>
      </div>
    </div>
  );
}
