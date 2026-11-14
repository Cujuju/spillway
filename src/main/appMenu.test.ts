import { afterAll, expect, it, vi } from 'vitest';

const menus = vi.hoisted(() => ({ template: [] as Electron.MenuItemConstructorOptions[] }));
vi.mock('electron', () => ({
  app: { name: 'Spillway' },
  Menu: { buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => { menus.template = template; return template; }, setApplicationMenu: vi.fn() },
}));
const requestQuit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./quit', () => ({ requestQuit }));

const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin' });
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

it('routes the macOS menu Quit and Command-Q through the shared quit confirmation', async () => {
  const { installAppMenu } = await import('./appMenu');
  installAppMenu(vi.fn());
  const items = menus.template.flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu : []) as Electron.MenuItemConstructorOptions[]);
  expect(items.some((item) => item.role === 'quit')).toBe(false);
  const quit = items.find((item) => item.accelerator === 'Command+Q');
  (quit?.click as () => void)();
  expect(requestQuit).toHaveBeenCalledOnce();
});
