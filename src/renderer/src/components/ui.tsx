import { Check, ChevronDown, ChevronUp, Copy, RotateCcw } from 'lucide-solid';
import { createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { resetParts } from '@shared/resetTime';
import { providerLabel } from '@shared/trayValues';
import { isBoolean, persistedSignal } from '../lib/persisted';
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

/** Number input that commits on blur or Enter, clamped by the settings normalizer. `unit` shows inside the box, after the number; `narrow` fits a short number in a table. */
export function NumberField(props: { value: number; onCommit: (v: number) => void; min?: number; max?: number; narrow?: boolean; unit?: string }) {
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v !== props.value) props.onCommit(v);
    else el.value = String(props.value);
  };
  return (
    <label class="input number-field" classList={{ narrow: props.narrow }}>
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

/**
 * Centres a dialog vertically on a whole pixel. At a half-pixel offset, borders and text round
 * in opposite directions, so paddings drift by 1px.
 */
function centreOnWholePixel(panel: HTMLElement) {
  const place = () => {
    panel.style.marginTop = `${Math.max(0, Math.floor((window.innerHeight - panel.offsetHeight) / 2))}px`;
  };
  const observer = new ResizeObserver(place);
  observer.observe(panel);
  window.addEventListener('resize', place);
  onCleanup(() => {
    observer.disconnect();
    window.removeEventListener('resize', place);
  });
}

/** Modal rendered on <body>, so it never inherits styles from where it's opened (e.g. a right-aligned table cell). */
export function Dialog(props: { title: string; onClose: () => void; children: JSX.Element; actions?: JSX.Element }) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return (
    <Portal>
      <div class="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="dialog" role="dialog" aria-label={props.title} ref={centreOnWholePixel}>
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
/** Glyph sizes, from tokens.css: small in dense tables, medium by default, large on pickers. */
const GLYPH_SIZE = { sm: 'var(--glyph-size-sm)', md: 'var(--glyph-size)', lg: 'var(--glyph-size-lg)' } as const;

export function ProviderGlyph(props: { provider: string; size?: keyof typeof GLYPH_SIZE }) {
  const uid = createUniqueId();
  const logo = () => providerLogo(props.provider, uid);
  const px = () => GLYPH_SIZE[props.size ?? 'md'];
  return (
    <Show
      when={logo()}
      fallback={
        <span class="provider-glyph" title={providerLabel(props.provider)} style={{ background: providerVar(props.provider), width: px(), height: px() }}>
          {providerLabel(props.provider).charAt(0)}
        </span>
      }
    >
      {/* Bundled SVGs (lib/providers.ts), inlined so currentColor follows the theme. */}
      {/* oxlint-disable-next-line solid/no-innerhtml */}
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
export function ExpandRow(props: { stateKey: string; label: string; help: string; action: string; children: JSX.Element }) {
  // A row's key is fixed, so reading it once is safe.
  // oxlint-disable-next-line solid/reactivity
  const [open, setOpen] = persistedSignal(`expand.${props.stateKey}`, false, isBoolean);
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

/** Copies a value and remembers it for a moment, so the control that copied it can confirm. */
export function createCopier() {
  const [copied, setCopied] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async (value: string) => {
    await window.api.copyText(value);
    setCopied(value);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(null), COPIED_SHOWN_MS);
  };
  return { copied, copy };
}

/**
 * Copies `value` and confirms with a check for a moment.
 * `chip` renders the icon-only chip button; otherwise a button labelled `label`.
 */
export function CopyButton(props: { value: string; what: string; label?: string; chip?: boolean; ghost?: boolean; disabled?: boolean }) {
  const copier = createCopier();
  const copied = () => copier.copied() === props.value;
  const title = () => (copied() ? 'Copied' : `Copy ${props.what}`);
  return (
    <button
      type="button"
      class={props.chip ? 'chip-btn' : 'btn'}
      classList={{ ghost: !props.chip && props.ghost, copied: copied() }}
      title={title()}
      aria-label={title()}
      disabled={props.disabled}
      onClick={() => void copier.copy(props.value)}
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
