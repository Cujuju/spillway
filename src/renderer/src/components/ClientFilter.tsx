import { ChevronDown, SquareTerminal } from 'lucide-solid';
import { createMemo, createUniqueId, For } from 'solid-js';
import type { ClientScope } from '@shared/activityScope';
import { setScopeKeys, type ClientOption } from '../lib/accountScope';
import { Check } from './AccountFilter';

const ICON_PX = 14;

/** Picks which clients (programs, by User-Agent) the Activity page shows. */
export function ClientFilter(props: { options: ClientOption[]; value: ClientScope; onChange: (next: ClientScope) => void }) {
  const menuId = createUniqueId();
  const all = createMemo(() => props.options.map((o) => o.key));
  const shown = (key: string) => props.value === null || props.value.includes(key);
  const label = () => {
    const v = props.value;
    if (v === null) return 'All clients';
    if (v.length === 1) return props.options.find((o) => o.key === v[0])?.label ?? '1 client';
    return v.length ? `${v.length} clients` : 'No clients';
  };

  return (
    <>
      <button type="button" class="btn account-filter-btn client-filter-btn" popovertarget={menuId} title="Clients shown">
        <SquareTerminal size={ICON_PX} />
        <span class="truncate">{label()}</span>
        <ChevronDown size={ICON_PX} />
      </button>
      <div id={menuId} popover class="account-menu client-menu" aria-label="Clients shown">
        <label class="account-menu-row account-menu-all">
          <Check checked={props.value === null} mixed={props.value !== null && props.value.length > 0} onChange={(on) => props.onChange(on ? null : [])} />
          <span>All clients</span>
        </label>
        <div class="account-menu-group">
          <For each={props.options}>
            {(o) => (
              <div class="account-menu-row account-menu-account">
                <label class="account-menu-pick" title={o.label}>
                  <Check checked={shown(o.key)} onChange={(on) => props.onChange(setScopeKeys(props.value, [o.key], on, all()))} />
                  <span class="truncate">{o.label}</span>
                </label>
                <button type="button" class="btn ghost account-menu-only" title={`Show only ${o.label}`} onClick={() => props.onChange([o.key])}>
                  Only
                </button>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  );
}
