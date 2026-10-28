import { ChevronDown, Users } from 'lucide-solid';
import { createEffect, createMemo, createUniqueId, For } from 'solid-js';
import type { AccountScope } from '@shared/activityScope';
import { providerLabel } from '@shared/trayValues';
import { setAccounts, type AccountGroup } from '../lib/accountScope';
import { ProviderGlyph } from './ui';

const ICON_PX = 14;
const OTHER_GROUP = 'Other accounts';

/** A checkbox that can show "some ticked": `indeterminate` is a DOM property with no attribute. */
function Check(props: { checked: boolean; mixed?: boolean; onChange: (on: boolean) => void }) {
  return (
    <input type="checkbox" checked={props.checked} ref={(el) => createEffect(() => { el.indeterminate = props.mixed === true; })}
      onChange={(e) => props.onChange(e.currentTarget.checked)} />
  );
}

/** Picks which accounts the Activity page shows: every account, whole providers, or single accounts. */
export function AccountFilter(props: { groups: AccountGroup[]; value: AccountScope; onChange: (next: AccountScope) => void }) {
  const menuId = createUniqueId();
  const all = createMemo(() => props.groups.flatMap((g) => g.accounts.map((a) => a.key)));
  const shown = (key: string) => props.value === null || props.value.includes(key);
  const label = () => {
    const v = props.value;
    if (v === null) return 'All accounts';
    if (v.length === 1) return props.groups.flatMap((g) => g.accounts).find((a) => a.key === v[0])?.label ?? '1 account';
    return v.length ? `${v.length} accounts` : 'No accounts';
  };
  const set = (keys: string[], on: boolean) => props.onChange(setAccounts(props.value, keys, on, all()));

  return (
    <>
      <button type="button" class="btn account-filter-btn" popovertarget={menuId} title="Accounts shown">
        <Users size={ICON_PX} />
        <span class="truncate">{label()}</span>
        <ChevronDown size={ICON_PX} />
      </button>
      <div id={menuId} popover class="account-menu" aria-label="Accounts shown">
        <label class="account-menu-row account-menu-all">
          <Check checked={props.value === null} mixed={props.value !== null && props.value.length > 0} onChange={(on) => props.onChange(on ? null : [])} />
          <span>All accounts</span>
        </label>
        <For each={props.groups}>
          {(group) => {
            const keys = () => group.accounts.map((a) => a.key);
            const count = () => keys().filter(shown).length;
            return (
              <div class="account-menu-group">
                <label class="account-menu-row account-menu-provider">
                  <Check checked={count() === keys().length} mixed={count() > 0 && count() < keys().length} onChange={(on) => set(keys(), on)} />
                  {group.provider ? <ProviderGlyph provider={group.provider} size="sm" /> : null}
                  <span>{group.provider ? providerLabel(group.provider) : OTHER_GROUP}</span>
                </label>
                <For each={group.accounts}>
                  {(a) => (
                    <div class="account-menu-row account-menu-account">
                      <label class="account-menu-pick" title={a.label}>
                        <Check checked={shown(a.key)} onChange={(on) => set([a.key], on)} />
                        <span class="truncate">{a.label}</span>
                      </label>
                      <button type="button" class="btn ghost account-menu-only" title={`Show only ${a.label}`} onClick={() => props.onChange([a.key])}>
                        Only
                      </button>
                    </div>
                  )}
                </For>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
}
