import { Check, ChevronDown, ChevronUp, Copy, RotateCcw } from 'lucide-solid';
import { createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { resetParts } from '@shared/resetTime';
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

/** Text on the left, control right-aligned. `stacked` puts a wide control (picker, path) under the text. */
export function SettingRow(props: { label: string; help?: string; nested?: boolean; stacked?: boolean; children: JSX.Element }) {
  return (
    <div class="list-row" classList={{ nested: props.nested, stacked: props.stacked }}>
      <div class="list-row-text">
        <div class="list-row-label">{props.label}</div>
        <Show when={props.help}>
          <div class="list-row-help">{props.help}</div>
        </Show>
      </div>
      <div class="list-row-actions">{props.children}</div>
    </div>
  );
}

/** One titled card of related settings rows. */
export function SettingsGroup(props: { title?: string; children: JSX.Element }) {
  return (
    <section class="card settings-group">
      <Show when={props.title}>
        <h2 class="card-title">{props.title}</h2>
      </Show>
      {props.children}
    </section>
  );
}

/** Number input that commits on blur or Enter, clamped by the settings normalizer. `unit` shows inside the box, after the number. */
export function NumberField(props: { value: number; onCommit: (v: number) => void; min?: number; max?: number; width?: number; unit?: string }) {
  const DEFAULT_WIDTH_PX = 90;
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v !== props.value) props.onCommit(v);
    else el.value = String(props.value);
  };
  return (
    <label class="input number-field" style={{ width: `${props.width ?? DEFAULT_WIDTH_PX}px` }}>
      <input
        class="tabular"
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget)}
      />
      <Show when={props.unit}>
        <span class="number-field-unit">{props.unit}</span>
      </Show>
    </label>
  );
}

/** Modal rendered on <body>, so it never inherits styles from where it's opened (e.g. a right-aligned table cell). */
export function Dialog(props: { title: string; onClose: () => void; children: JSX.Element; actions?: JSX.Element }) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return (
    <Portal>
      <div class="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="dialog" role="dialog" aria-label={props.title}>
          <h2 class="card-title">{props.title}</h2>
          {props.children}
          <Show when={props.actions}>
            <div class="dialog-actions">{props.actions}</div>
          </Show>
        </div>
      </div>
    </Portal>
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

/** Reset countdown: icon and time left; the local reset date and time show on hover. */
export function ResetTime(props: { at: string | number; now: number }) {
  return (
    <span class="reset-time" title={new Date(props.at).toLocaleString()}>
      <RotateCcw size="1em" role="img" aria-label="Resets in" />
      {resetParts(props.at, props.now).left}
    </span>
  );
}

/** Chevron size beside a text button label. */
const CHEVRON_PX = 14;

/** A list row whose details open in an inset panel beneath it. */
export function ExpandRow(props: { label: string; help: string; action: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="list-row">
      <div class="list-row-text">
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

/** Long enough to notice, short enough that a second copy shows a fresh confirmation. */
const COPIED_SHOWN_MS = 1500;
const COPY_ICON_PX = 14;

/**
 * Copies `value` and confirms with a check for a moment.
 * `chip` renders the icon-only chip button; otherwise a button labelled `label`.
 */
export function CopyButton(props: { value: string; what: string; label?: string; chip?: boolean; ghost?: boolean; disabled?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    await window.api.copyText(props.value);
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), COPIED_SHOWN_MS);
  };
  const title = () => (copied() ? 'Copied' : `Copy ${props.what}`);
  return (
    <button
      type="button"
      class={props.chip ? 'chip-btn' : 'btn'}
      classList={{ ghost: !props.chip && props.ghost, copied: copied() }}
      title={title()}
      aria-label={title()}
      disabled={props.disabled}
      onClick={() => void copy()}
    >
      <Show when={copied()} fallback={<Copy size={COPY_ICON_PX} />}>
        <Check size={COPY_ICON_PX} />
      </Show>
      <Show when={!props.chip}>{copied() ? 'Copied' : (props.label ?? 'Copy')}</Show>
    </button>
  );
}

export function Notice(props: { tone?: 'warn' | 'error' | 'info'; children: JSX.Element }) {
  return <div class="notice" classList={{ error: props.tone === 'error', info: props.tone === 'info' }}>{props.children}</div>;
}
