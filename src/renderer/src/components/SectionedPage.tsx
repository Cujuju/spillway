import { For, Show, type JSX } from 'solid-js';

/** A nav entry. `title` heads the body when the short nav `label` is not enough. */
export interface NavItem<T extends string> {
  id: T;
  label: string;
  title?: string;
  /** Leaves a gap above the item, setting it apart from the rest of its group. */
  gapBefore?: boolean;
}

export interface NavGroup<T extends string> {
  group: string;
  items: readonly NavItem<T>[];
}

/** Grouped section list on the left; the selected section's title and body on the right. */
export function SectionedPage<T extends string>(props: { nav: readonly NavGroup<T>[]; section: T; onSelect: (id: T) => void; children: JSX.Element }) {
  const current = () => props.nav.flatMap((g) => g.items).find((i) => i.id === props.section);
  return (
    <div class="sectioned">
      <nav class="sectioned-nav">
        <For each={props.nav}>
          {(g) => (
            <>
              <div class="sidebar-group">{g.group}</div>
              <For each={g.items}>
                {(i) => (
                  <>
                    <Show when={i.gapBefore}>
                      <div class="sectioned-nav-gap" />
                    </Show>
                    <button class="nav-btn" classList={{ active: props.section === i.id }} onClick={() => props.onSelect(i.id)}>{i.label}</button>
                  </>
                )}
              </For>
            </>
          )}
        </For>
      </nav>
      <section class="sectioned-body">
        <header class="dash-header">
          <h1 class="dash-title">{current()?.title ?? current()?.label ?? ''}</h1>
        </header>
        {props.children}
      </section>
    </div>
  );
}
