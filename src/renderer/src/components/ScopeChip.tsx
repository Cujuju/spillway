import { ChevronDown, X } from 'lucide-solid';
import { createUniqueId, For, Show, type JSX } from 'solid-js';

const ICON_PX = 12;

/**
 * One phrase of a scope sentence: a chip that opens `children` in a popover anchored under it.
 * `active` marks a narrowed scope; with `onClear` it also shows a reset button.
 */
export function ScopeChip(props: { label: string; value: string; active: boolean; onClear?: () => void; menuClass?: string; children: JSX.Element }) {
  const id = createUniqueId();
  const anchor = `--scope-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <>
      <span class="scope-chip" classList={{ active: props.active }} style={{ '--scope-anchor': anchor }}>
        <button type="button" class="scope-chip-btn" popovertarget={id} aria-label={`${props.label}: ${props.value}`} title={props.value}>
          <span class="truncate">{props.value}</span>
          <ChevronDown size={ICON_PX} aria-hidden="true" />
        </button>
        <Show when={props.active && props.onClear}>
          <button type="button" class="scope-chip-clear" aria-label={`Clear ${props.label.toLowerCase()}`} onClick={() => props.onClear?.()}><X size={ICON_PX} /></button>
        </Show>
      </span>
      <div id={id} popover class={props.menuClass ? `account-menu ${props.menuClass}` : 'account-menu'} style={{ '--scope-anchor': anchor }} aria-label={props.label}>
        {props.children}
      </div>
    </>
  );
}

/** A scope phrase with one choice from a short list (usage source, effort). */
export function ChoiceChip<T extends string>(props: { label: string; value: T; initial: T; options: readonly { value: T; label: string; phrase: string }[]; onChange: (v: T) => void }) {
  const current = () => props.options.find((o) => o.value === props.value) ?? props.options[0]!;
  return (
    <ScopeChip label={props.label} value={current().phrase} active={props.value !== props.initial} onClear={() => props.onChange(props.initial)} menuClass="choice-menu">
      <For each={props.options}>
        {(o) => (
          <label class="account-menu-row">
            <input type="radio" name={props.label} checked={o.value === props.value} onChange={(e) => {
              // Look up the menu first: a new option list can replace this input.
              const menu = e.currentTarget.closest<HTMLElement>('[popover]');
              props.onChange(o.value);
              menu?.hidePopover();
            }} />
            <span>{o.label}</span>
          </label>
        )}
      </For>
    </ScopeChip>
  );
}
