import { createEffect } from 'solid-js';
import { APP_NAME } from '@shared/app';
import { resetText } from '@shared/resetTime';
import { percentText, providerLabel, readTray, shownPercent, trayIconText } from '@shared/trayValues';
import { poolWindowKey } from '../lib/forecast';
import { drawTrayIcon, paintFor, TRAY_PX_1X, TRAY_PX_2X } from '../lib/trayRender';
import { activeTheme, now, proxyStatus, settings, snapshot, taskbarDark } from '../store';
import { poolRemaining } from './poolModel';

/** Windows truncates tray tooltips past 127 characters. */
const TOOLTIP_MAX = 127;
const clip = (s: string) => (s.length > TOOLTIP_MAX ? `${s.slice(0, TOOLTIP_MAX - 1)}…` : s);

/** Keeps the per-limit tray icons and the app tray tooltip in step with the latest usage. */
export function TrayIconSync() {
  let lastLimitSignature: string | null = null;
  let lastAppTooltip: string | null = null;

  createEffect(() => {
    const t = settings().trayIcons;
    const snap = snapshot();
    const time = now();
    const darkTaskbar = taskbarDark();
    const palette = activeTheme().palette;
    if (!t.enabled) {
      if (lastLimitSignature !== '') {
        lastLimitSignature = '';
        void window.api.setLimitTrays([]);
      }
      return;
    }
    const specs = t.items.map((spec) => {
      const reading = readTray(spec, snap, poolRemaining);
      const shown = shownPercent(reading.usedPercent, t.value);
      const text = trayIconText(shown);
      const paint = paintFor(spec, darkTaskbar, reading.usedPercent, t, palette);
      const valueText = shown === null ? 'no data' : `${percentText(shown)}% ${t.value}`;
      const reset = reading.resetsAt ? ` · ${resetText(reading.resetsAt, time)}` : '';
      const tooltip = clip(`${reading.title}: ${valueText}${reset}\n${reading.source}`);
      return { id: spec.id, text, paint, tooltip };
    });
    const signature = specs.map((s) => `${s.id}\0${s.text}\0${s.paint.shape}\0${s.paint.fill}\0${s.paint.color}\0${s.paint.darkTaskbar ? 1 : 0}\0${s.tooltip}`).join('\u0001');
    if (signature === lastLimitSignature) return;
    lastLimitSignature = signature;
    void window.api.setLimitTrays(specs.map((s) => ({
      id: s.id,
      png1x: drawTrayIcon(TRAY_PX_1X, s.text, s.paint),
      png2x: drawTrayIcon(TRAY_PX_2X, s.text, s.paint),
      tooltip: s.tooltip,
    })));
  });

  createEffect(() => {
    const snap = snapshot();
    const state = proxyStatus()?.state ?? 'stopped';
    const lines = [`${APP_NAME} · proxy ${state}`];
    const providers = [...new Set((snap?.credentials ?? []).map((c) => c.provider))];
    for (const provider of providers) {
      const creds = snap!.credentials.filter((c) => c.provider === provider);
      const key = poolWindowKey(creds);
      if (!key) continue;
      lines.push(`${providerLabel(provider)}: ${percentText(poolRemaining(creds, key))}% of pool left`);
    }
    const next = clip(lines.join('\n'));
    if (next === lastAppTooltip) return;
    lastAppTooltip = next;
    void window.api.setAppTooltip(next);
  });

  return null;
}
