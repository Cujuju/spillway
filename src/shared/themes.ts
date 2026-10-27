/** Built-in colour themes (StockApp model): each theme is a full set of base colours. Tints derive in tokens.css. */

export type ThemeScheme = 'dark' | 'light';

export interface Palette {
  background: string;
  sunken: string;
  surface: string;
  raised: string;
  input: string;
  hover: string;
  border: string;
  borderStrong: string;
  text: string;
  soft: string;
  secondary: string;
  muted: string;
  disabled: string;
  accent: string;
  accentLight: string;
  onAccent: string;
  green: string;
  amber: string;
  red: string;
  redLight: string;
}

export interface Theme {
  id: string;
  label: string;
  scheme: ThemeScheme;
  palette: Palette;
}

/** CSS custom property behind each palette entry. */
const TOKEN: Record<keyof Palette, string> = {
  background: '--color-background',
  sunken: '--color-surface-sunken',
  surface: '--color-surface',
  raised: '--color-surface-raised',
  input: '--color-surface-input',
  hover: '--color-surface-hover',
  border: '--color-border',
  borderStrong: '--color-border-strong',
  text: '--color-text',
  soft: '--color-text-soft',
  secondary: '--color-text-secondary',
  muted: '--color-text-muted',
  disabled: '--color-text-disabled',
  accent: '--color-accent',
  accentLight: '--color-accent-light',
  onAccent: '--color-on-accent',
  green: '--color-green',
  amber: '--color-amber',
  red: '--color-red',
  redLight: '--color-red-light',
};

export const THEMES: readonly Theme[] = [
  {
    id: 'dark', label: 'Midnight', scheme: 'dark',
    palette: {
      background: '#0a0f1c', sunken: '#0f172a', surface: '#16213e', raised: '#1e293b', input: '#252d3f', hover: '#2d3548',
      border: 'rgba(255, 255, 255, 0.1)', borderStrong: '#475569',
      text: '#e2e8f0', soft: '#cbd5e1', secondary: '#94a3b8', muted: '#64748b', disabled: '#475569',
      accent: '#6366f1', accentLight: '#818cf8', onAccent: '#ffffff',
      green: '#10b981', amber: '#f59e0b', red: '#ef4444', redLight: '#fca5a5',
    },
  },
  {
    // StockApp's Tonal theme: near-black wells, cool controls.
    id: 'tonal', label: 'Tonal', scheme: 'dark',
    palette: {
      background: '#0d0d0d', sunken: '#070707', surface: '#12151c', raised: '#181c26', input: '#1e2334', hover: '#262c40',
      border: 'rgba(255, 255, 255, 0.08)', borderStrong: '#3b4256',
      text: '#e4e7ee', soft: '#c9cede', secondary: '#8f97ab', muted: '#5f677b', disabled: '#434a5c',
      accent: '#6366f1', accentLight: '#818cf8', onAccent: '#ffffff',
      green: '#10b981', amber: '#f59e0b', red: '#ef4444', redLight: '#fca5a5',
    },
  },
  {
    id: 'oled', label: 'OLED Black', scheme: 'dark',
    palette: {
      background: '#000000', sunken: '#000000', surface: '#0b0b0d', raised: '#141417', input: '#1a1a1f', hover: '#232329',
      border: 'rgba(255, 255, 255, 0.09)', borderStrong: '#3f3f46',
      text: '#e4e4e7', soft: '#d4d4d8', secondary: '#a1a1aa', muted: '#71717a', disabled: '#52525b',
      accent: '#6366f1', accentLight: '#818cf8', onAccent: '#ffffff',
      green: '#22c55e', amber: '#f59e0b', red: '#ef4444', redLight: '#fca5a5',
    },
  },
  {
    id: 'nord', label: 'Nord', scheme: 'dark',
    palette: {
      background: '#242933', sunken: '#2a303c', surface: '#2e3440', raised: '#3b4252', input: '#434c5e', hover: '#4c566a',
      border: 'rgba(216, 222, 233, 0.1)', borderStrong: '#4c566a',
      text: '#eceff4', soft: '#d8dee9', secondary: '#9aa5b8', muted: '#6f7a8e', disabled: '#4c566a',
      accent: '#88c0d0', accentLight: '#8fbcbb', onAccent: '#2e3440',
      green: '#a3be8c', amber: '#ebcb8b', red: '#bf616a', redLight: '#d8838b',
    },
  },
  {
    id: 'dracula', label: 'Dracula', scheme: 'dark',
    palette: {
      background: '#191a21', sunken: '#1e1f29', surface: '#282a36', raised: '#2f3241', input: '#343746', hover: '#44475a',
      border: 'rgba(248, 248, 242, 0.1)', borderStrong: '#6272a4',
      text: '#f8f8f2', soft: '#e6e6e0', secondary: '#a9b1d6', muted: '#6272a4', disabled: '#4d5470',
      accent: '#bd93f9', accentLight: '#caa9fa', onAccent: '#191a21',
      green: '#50fa7b', amber: '#ffb86c', red: '#ff5555', redLight: '#ff6e6e',
    },
  },
  {
    id: 'mocha', label: 'Catppuccin Mocha', scheme: 'dark',
    palette: {
      background: '#11111b', sunken: '#181825', surface: '#1e1e2e', raised: '#2a2b3c', input: '#313244', hover: '#45475a',
      border: 'rgba(205, 214, 244, 0.1)', borderStrong: '#585b70',
      text: '#cdd6f4', soft: '#bac2de', secondary: '#a6adc8', muted: '#7f849c', disabled: '#585b70',
      accent: '#cba6f7', accentLight: '#b4befe', onAccent: '#11111b',
      green: '#a6e3a1', amber: '#f9e2af', red: '#f38ba8', redLight: '#eba0ac',
    },
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', scheme: 'dark',
    palette: {
      background: '#00212b', sunken: '#002731', surface: '#002b36', raised: '#073642', input: '#0a3d4a', hover: '#124956',
      border: 'rgba(147, 161, 161, 0.15)', borderStrong: '#586e75',
      text: '#eee8d5', soft: '#93a1a1', secondary: '#839496', muted: '#657b83', disabled: '#586e75',
      accent: '#268bd2', accentLight: '#4ba3e3', onAccent: '#fdf6e3',
      green: '#859900', amber: '#b58900', red: '#dc322f', redLight: '#e9706b',
    },
  },
  {
    id: 'light', label: 'Light', scheme: 'light',
    palette: {
      background: '#eef1f6', sunken: '#e4e8ef', surface: '#ffffff', raised: '#f6f8fb', input: '#e2e7ef', hover: '#d6dce6',
      border: 'rgba(15, 23, 42, 0.12)', borderStrong: '#94a3b8',
      text: '#0f172a', soft: '#1e293b', secondary: '#475569', muted: '#64748b', disabled: '#94a3b8',
      accent: '#4f46e5', accentLight: '#4f46e5', onAccent: '#ffffff',
      green: '#059669', amber: '#d97706', red: '#dc2626', redLight: '#b91c1c',
    },
  },
  {
    id: 'latte', label: 'Catppuccin Latte', scheme: 'light',
    palette: {
      background: '#e6e9ef', sunken: '#dce0e8', surface: '#eff1f5', raised: '#f5f6f9', input: '#d5d9e2', hover: '#ccd0da',
      border: 'rgba(76, 79, 105, 0.14)', borderStrong: '#9ca0b0',
      text: '#4c4f69', soft: '#5c5f77', secondary: '#6c6f85', muted: '#8c8fa1', disabled: '#acb0be',
      accent: '#8839ef', accentLight: '#8839ef', onAccent: '#ffffff',
      green: '#40a02b', amber: '#df8e1d', red: '#d20f39', redLight: '#d20f39',
    },
  },
  {
    id: 'solarized-light', label: 'Solarized Light', scheme: 'light',
    palette: {
      background: '#eee8d5', sunken: '#e6dfc8', surface: '#fdf6e3', raised: '#f7f0dc', input: '#e2dac2', hover: '#d9d0b5',
      border: 'rgba(88, 110, 117, 0.18)', borderStrong: '#93a1a1',
      text: '#073642', soft: '#586e75', secondary: '#657b83', muted: '#839496', disabled: '#93a1a1',
      accent: '#268bd2', accentLight: '#268bd2', onAccent: '#fdf6e3',
      green: '#859900', amber: '#b58900', red: '#dc322f', redLight: '#dc322f',
    },
  },
];

/** Follows the OS light/dark preference using the two themes below. */
export const SYSTEM_THEME = 'system';
const SYSTEM_DARK_ID = 'dark';
const SYSTEM_LIGHT_ID = 'light';

/** Valid stored values for settings.general.theme. */
export const THEME_CHOICES: readonly string[] = [SYSTEM_THEME, ...THEMES.map((t) => t.id)];

const byId = (id: string) => THEMES.find((t) => t.id === id);

export function resolveTheme(choice: string, prefersDark: boolean): Theme {
  const id = choice === SYSTEM_THEME ? (prefersDark ? SYSTEM_DARK_ID : SYSTEM_LIGHT_ID) : choice;
  return byId(id) ?? byId(SYSTEM_DARK_ID)!;
}

/** Palette as CSS custom properties, for document or preview-scope inline styles. */
export function themeTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(TOKEN) as (keyof Palette)[]) out[TOKEN[key]] = theme.palette[key];
  return out;
}
