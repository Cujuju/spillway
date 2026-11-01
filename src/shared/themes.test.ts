import { expect, it } from 'vitest';
import { darkTheme, THEMES } from './themes';

it('gives every theme a dark scene palette: itself when dark, a named sibling when light', () => {
  for (const theme of THEMES) {
    const scene = darkTheme(theme);
    expect(scene.scheme).toBe('dark');
    if (theme.scheme === 'dark') expect(scene).toBe(theme);
  }
  const ids = (light: string) => darkTheme(THEMES.find((t) => t.id === light)!).id;
  expect([ids('light'), ids('latte'), ids('solarized-light')]).toEqual(['dark', 'mocha', 'solarized-dark']);
});
