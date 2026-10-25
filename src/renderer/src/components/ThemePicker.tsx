import { For, type JSX } from 'solid-js';
import { resolveTheme, SYSTEM_THEME, THEMES, themeTokens, type Theme } from '@shared/themes';

/** Miniature of the app in a theme's own colours: sidebar, card, text lines, accent and status colours. */
function Preview(props: { theme: Theme }) {
  return (
    <div class="theme-scope theme-preview" style={themeTokens(props.theme)}>
      <div class="theme-preview-side" />
      <div class="theme-preview-card">
        <div class="theme-preview-line" />
        <div class="theme-preview-line short" />
        <div class="theme-preview-dots">
          <span class="theme-preview-accent" />
          <span style={{ background: 'var(--color-green)' }} />
          <span style={{ background: 'var(--color-amber)' }} />
          <span style={{ background: 'var(--color-red)' }} />
        </div>
      </div>
    </div>
  );
}

function Card(props: { label: string; active: boolean; onSelect: () => void; children: JSX.Element }) {
  return (
    <button type="button" class="theme-card" classList={{ active: props.active }} aria-pressed={props.active} onClick={() => props.onSelect()}>
      {props.children}
      <span class="theme-card-label">{props.label}</span>
    </button>
  );
}

export function ThemePicker(props: { value: string; onChange: (id: string) => void }) {
  return (
    <div class="theme-grid">
      <Card label="System" active={props.value === SYSTEM_THEME} onSelect={() => props.onChange(SYSTEM_THEME)}>
        <div class="theme-split">
          <Preview theme={resolveTheme(SYSTEM_THEME, true)} />
          <Preview theme={resolveTheme(SYSTEM_THEME, false)} />
        </div>
      </Card>
      <For each={THEMES}>
        {(t) => (
          <Card label={t.label} active={props.value === t.id} onSelect={() => props.onChange(t.id)}>
            <Preview theme={t} />
          </Card>
        )}
      </For>
    </div>
  );
}
