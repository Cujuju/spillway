import { createEffect } from 'solid-js';
import { APP_NAME } from '@shared/app';
import { resetText } from '@shared/resetTime';
import { providerLabel, readTray, shownPercent, trayIconText } from '@shared/trayValues';
import { poolWindowKey } from '../lib/forecast';
import { drawTrayIcon, paintFor, TRAY_PX_1X, TRAY_PX_2X } from '../lib/trayRender';
import { now, proxyStatus, settings, snapshot, taskbarDark } from '../store';
import { poolRemaining } from './poolModel';

/** Windows truncates tray tooltips past 127 characters. */
const TOOLTIP_MAX = 127;
const clip = (s: string) => (s.length > TOOLTIP_MAX ? `${s.slice(0, TOOLTIP_MAX - 1)}…` : s);

/** Keeps the per-limit tray icons and the app tray tooltip in step with the latest usage. */
export function TrayIconSync() {
  createEffect(() => {
    const t = settings().trayIcons;
    const snap = snapshot();
    const time = now();
    const darkTaskbar = taskbarDark();
    if (!t.enabled) {
      void window.api.setLimitTrays([]);
      return;
    }
    const images = t.items.map((spec) => {
      const reading = readTray(spec, snap, poolRemaining);
      const shown = shownPercent(reading.usedPercent, t.value);
      const text = trayIconText(shown);
      const paint = paintFor(spec, darkTaskbar);
      const valueText = shown === null ? 'no data' : `${Math.round(shown)}% ${t.value}`;
      const reset = reading.resetsAt ? ` · ${resetText(reading.resetsAt, time)}` : '';
      return {
        id: spec.id,
        png1x: drawTrayIcon(TRAY_PX_1X, text, paint),
        png2x: drawTrayIcon(TRAY_PX_2X, text, paint),
        tooltip: clip(`${reading.title}: ${valueText}${reset}\n${reading.source}`),
      };
    });
    void window.api.setLimitTrays(images);
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
      lines.push(`${providerLabel(provider)}: ${Math.round(poolRemaining(creds, key))}% of pool left`);
    }
    void window.api.setAppTooltip(clip(lines.join('\n')));
  });

  return null;
}
