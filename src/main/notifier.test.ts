import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoticeDelivery, NoticeInput } from '@shared/notice';

const shown = vi.fn();
vi.mock('electron', () => ({
  Notification: class {
    static isSupported = () => true;
    on = vi.fn();
    show = shown;
  },
}));
vi.mock('./noticeOverlay', () => ({ noticeOverlay: { show: vi.fn() } }));
vi.mock('./paths', () => ({ appIconPath: () => 'icon.png' }));
vi.mock('./settingsStore', () => ({ getSettings: vi.fn() }));
vi.mock('./window', () => ({ showMainWindow: vi.fn(), showWindowAndSend: vi.fn() }));

const { notify } = await import('./notifier');
const { noticeOverlay } = await import('./noticeOverlay');
const { getSettings } = await import('./settingsStore');

const input: NoticeInput = { kind: 'proxyStopped', target: 'proxy', title: 'Proxy stopped', body: 'Exit code 1', short: 'Proxy stopped' };
const deliver = (delivery: NoticeDelivery) => {
  vi.mocked(getSettings).mockReturnValue({ notifications: { delivery } } as ReturnType<typeof getSettings>);
  notify(input);
};

describe('notify', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['spillway', 0, 1],
    ['system', 1, 0],
    ['both', 1, 1],
  ] as const)('%s delivery: %i system, %i overlay', (delivery, system, overlay) => {
    deliver(delivery);
    expect(shown).toHaveBeenCalledTimes(system);
    expect(noticeOverlay.show).toHaveBeenCalledTimes(overlay);
  });

  it('gives each overlay notice its own id and time', () => {
    deliver('spillway');
    deliver('spillway');
    const [a, b] = vi.mocked(noticeOverlay.show).mock.calls.map((c) => c[0]);
    expect(a).toMatchObject(input);
    expect(a!.id).not.toBe(b!.id);
    expect(typeof a!.at).toBe('number');
  });
});
