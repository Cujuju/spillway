import { ColorSwatch, extractBaseHex, type PickerTokens } from '@cujuju/solidjs-color-picker';
import { Show } from 'solid-js';
import type { TrayIconFill, TrayIconLook, TrayIconShape } from '@shared/settings';
import { providerColor } from '../lib/providers';
import { Seg } from './ui';

const SHAPES: readonly { value: TrayIconShape; label: string }[] = [
  { value: 'square', label: 'Square' },
  { value: 'circle', label: 'Circle' },
  { value: 'none', label: 'Digits only' },
];
const FILLS: readonly { value: TrayIconFill; label: string }[] = [
  { value: 'outline', label: 'Outline' },
  { value: 'filled', label: 'Filled' },
];
/** Picker chrome in the app theme's colours, so it follows every theme. */
const PICKER_TOKENS: Partial<PickerTokens> = {
  bg: 'var(--color-surface-raised)',
  bgInput: 'var(--color-surface-input)',
  border: 'var(--color-border)',
  borderHover: 'var(--color-border-strong)',
  text: 'var(--color-text)',
  textMuted: 'var(--color-text-secondary)',
  textDim: 'var(--color-text-muted)',
  accent: 'var(--color-accent)',
  textOnAccent: 'var(--color-on-accent)',
};

/** Shape, fill and colour of one tray icon. */
export function TrayIconLookEditor(props: {
  look: TrayIconLook;
  provider: string;
  savedColors: string[];
  onChange: (look: TrayIconLook) => void;
  onSavedColorsChange: (colors: string[]) => void;
}) {
  const color = () => props.look.color ?? providerColor(props.provider);
  return (
    <div class="tray-look">
      <Seg value={props.look.shape} options={SHAPES} onChange={(shape) => props.onChange({ ...props.look, shape })} />
      <Show when={props.look.shape !== 'none'}>
        <Seg value={props.look.fill} options={FILLS} onChange={(fill) => props.onChange({ ...props.look, fill })} />
      </Show>
      <ColorSwatch
        value={color()}
        onChange={(v) => {
          const hex = extractBaseHex(v).toLowerCase();
          // Cancel re-sends the colour the picker opened with; unchanged, it is no edit.
          if (hex !== color().toLowerCase()) props.onChange({ ...props.look, color: hex });
        }}
        savedColors={props.savedColors}
        onSavedColorsChange={props.onSavedColorsChange}
        label="Icon colour"
        tokens={PICKER_TOKENS}
        alpha={false}
      />
      <Show when={props.look.color !== null}>
        <button class="btn ghost" onClick={() => props.onChange({ ...props.look, color: null })}>Use provider colour</button>
      </Show>
    </div>
  );
}
