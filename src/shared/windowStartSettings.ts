/** Settings for starting each account's 5-hour window as soon as it resets. */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
/** Defaults the active-hours fields show before the user picks their own day. */
const DEFAULT_ACTIVE_START_MINUTE = 8 * MINUTES_PER_HOUR;
const DEFAULT_ACTIVE_END_MINUTE = 23 * MINUTES_PER_HOUR;

/** Providers whose 5-hour window starts with the first request and that the proxy can start. */
export const WINDOW_START_PROVIDERS = ['claude', 'codex'] as const;
export type WindowStartProvider = (typeof WINDOW_START_PROVIDERS)[number];

/** What a window start sends, per provider. Mirrors the fork's `desktop_window_start.go`; update both together. */
export const WINDOW_START_REQUEST: Record<WindowStartProvider, string> = {
  claude: 'Sends “Reply with OK.” capped at 1 output token, with no thinking requested.',
  codex: 'Sends “Reply with OK.” at the lowest reasoning effort the model accepts. Codex allows no output cap.',
};

export interface ActiveHours {
  /** Off starts windows at any hour. */
  enabled: boolean;
  /** Local minutes after midnight. An end before the start spans midnight. */
  startMinute: number;
  endMinute: number;
}

export interface WindowStartSettings {
  /** Sends one minimal request per account when its 5-hour window resets, so the next window starts at once. */
  enabled: boolean;
  /** Model per provider; '' uses the cheapest priced model the account offers. */
  models: Record<WindowStartProvider, string>;
  activeHours: ActiveHours;
  /** Spaces starts evenly across a provider's accounts instead of starting every window at once. */
  stagger: boolean;
}

export const DEFAULT_WINDOW_START: WindowStartSettings = {
  enabled: false,
  models: { claude: '', codex: '' },
  activeHours: { enabled: false, startMinute: DEFAULT_ACTIVE_START_MINUTE, endMinute: DEFAULT_ACTIVE_END_MINUTE },
  stagger: false,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const minute = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < MINUTES_PER_DAY ? (v as number) : d);
const model = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function normalizeWindowStart(raw: unknown): WindowStartSettings {
  const d = DEFAULT_WINDOW_START;
  const r = obj(raw), m = obj(r.models), h = obj(r.activeHours);
  return {
    enabled: bool(r.enabled, d.enabled),
    models: { claude: model(m.claude), codex: model(m.codex) },
    activeHours: {
      enabled: bool(h.enabled, d.activeHours.enabled),
      startMinute: minute(h.startMinute, d.activeHours.startMinute),
      endMinute: minute(h.endMinute, d.activeHours.endMinute),
    },
    stagger: bool(r.stagger, d.stagger),
  };
}

/** Whether `date`'s local time falls in the active hours. Equal start and end means all day. */
export function withinActiveHours(hours: ActiveHours, date: Date): boolean {
  if (!hours.enabled || hours.startMinute === hours.endMinute) return true;
  const now = date.getHours() * MINUTES_PER_HOUR + date.getMinutes();
  return hours.startMinute < hours.endMinute
    ? now >= hours.startMinute && now < hours.endMinute
    : now >= hours.startMinute || now < hours.endMinute;
}

/** "HH:MM" for an `<input type="time">`. */
export const minuteToTime = (m: number) => `${String(Math.floor(m / MINUTES_PER_HOUR)).padStart(2, '0')}:${String(m % MINUTES_PER_HOUR).padStart(2, '0')}`;

/** Minutes after midnight from "HH:MM"; null when malformed. */
export function timeToMinute(text: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
  return Number(match[2]) < MINUTES_PER_HOUR && value < MINUTES_PER_DAY ? value : null;
}
