import { ChevronDown, ChevronUp } from 'lucide-solid';
import { createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { providerLabel } from '@shared/trayValues';
import { providerLogo, providerVar } from '../lib/providers';

/** StockApp-style On/Off toggle. */
export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      class="toggle"
      classList={{ on: props.value }}
      aria-pressed={props.value}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.value)}
    >
      {props.value ? 'On' : 'Off'}
    </button>
  );
}

export function Seg<T extends string | number>(props: { value: T; options: readonly { value: T; label: string; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup">
      <For each={props.options}>
        {(o) => (
          <button type="button" role="radio" aria-checked={props.value === o.value} title={o.title} classList={{ active: props.value === o.value }} onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function SettingRow(props: { label: string; help?: string; nested?: boolean; children: JSX.Element }) {
  return (
    <div class="setting-row" classList={{ nested: props.nested }}>
      <div class="setting-text">
        <div class="setting-label">{props.label}</div>
        <Show when={props.help}>
          <div class="setting-help">{props.help}</div>
        </Show>
      </div>
      <div class="setting-control">{props.children}</div>
    </div>
  );
}

/** Number input that commits on blur or Enter, clamped by the settings normalizer. */
export function NumberField(props: { value: number; onCommit: (v: number) => void; min?: number; max?: number; width?: number; suffix?: string }) {
  const DEFAULT_WIDTH_PX = 90;
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v !== props.value) props.onCommit(v);
    else el.value = String(props.value);
  };
  return (
    <span class="row">
      <input
        class="input tabular"
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        style={{ width: `${props.width ?? DEFAULT_WIDTH_PX}px` }}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget)}
      />
      <Show when={props.suffix}>
        <span class="muted">{props.suffix}</span>
      </Show>
    </span>
  );
}

export function Dialog(props: { title: string; onClose: () => void; children: JSX.Element; actions?: JSX.Element }) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return (
    <div class="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label={props.title}>
        <h2 class="card-title">{props.title}</h2>
        {props.children}
        <Show when={props.actions}>
          <div class="dialog-actions">{props.actions}</div>
        </Show>
      </div>
    </div>
  );
}

/** Provider brand mark; providers without one get a coloured tile with their initial. */
export function ProviderGlyph(props: { provider: string; size?: number }) {
  const DEFAULT_PX = 18;
  const uid = createUniqueId();
  const logo = () => providerLogo(props.provider, uid);
  const px = () => `${props.size ?? DEFAULT_PX}px`;
  return (
    <Show
      when={logo()}
      fallback={
        <span class="provider-glyph" title={providerLabel(props.provider)} style={{ background: providerVar(props.provider), width: px(), height: px() }}>
          {providerLabel(props.provider).charAt(0)}
        </span>
      }
    >
      <span class="provider-logo" title={providerLabel(props.provider)} style={{ width: px(), height: px() }} innerHTML={logo()} />
    </Show>
  );
}

/** Chevron size beside a text button label. */
const CHEVRON_PX = 14;

/** A list row whose details open in an inset panel beneath it. */
export function ExpandRow(props: { label: string; help: string; action: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="list-row">
      <div>
        <div class="list-row-label">{props.label}</div>
        <div class="list-row-help">{props.help}</div>
      </div>
      <div class="list-row-actions">
        <button type="button" class="btn ghost" aria-expanded={open()} onClick={() => setOpen(!open())}>
          {props.action}
          <Show when={open()} fallback={<ChevronDown size={CHEVRON_PX} />}>
            <ChevronUp size={CHEVRON_PX} />
          </Show>
        </button>
      </div>
      <Show when={open()}>
        <div class="list-row-detail">{props.children}</div>
      </Show>
    </div>
  );
}

export function Notice(props: { tone?: 'warn' | 'error' | 'info'; children: JSX.Element }) {
  return <div class="notice" classList={{ error: props.tone === 'error', info: props.tone === 'info' }}>{props.children}</div>;
}
