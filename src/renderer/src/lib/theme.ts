import { themeTokens, type Theme } from '@shared/themes';

/** Paints a theme's palette onto an element as CSS custom properties. */
export function paintTheme(el: HTMLElement, theme: Theme): void {
  for (const [name, value] of Object.entries(themeTokens(theme))) el.style.setProperty(name, value);
  el.style.colorScheme = theme.scheme;
  el.dataset.theme = theme.id;
}
