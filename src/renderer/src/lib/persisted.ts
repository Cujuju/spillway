import { createSignal, type Signal } from 'solid-js';

/** Namespaces view state in localStorage, apart from anything else the renderer may store. */
const KEY_PREFIX = 'spillway.view.';

/** Accepts a stored value: a list of allowed values, or a type check for open-ended ones. */
export type Accepts<T> = readonly T[] | ((v: unknown) => v is T);

const accepted = <T,>(v: unknown, accepts: Accepts<T>): v is T =>
  typeof accepts === 'function' ? accepts(v) : (accepts as readonly unknown[]).includes(v);

function read<T>(key: string, initial: T, accepts: Accepts<T>): T {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (raw === null) return initial;
    const v: unknown = JSON.parse(raw);
    return accepted(v, accepts) ? v : initial;
  } catch {
    return initial;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the value still holds for this session.
  }
}

/**
 * A signal whose value survives restarts: view state such as tabs, ranges and filters.
 * A stored value that `accepts` rejects (renamed option, old format) falls back to `initial`.
 */
export function persistedSignal<T>(key: string, initial: T, accepts: Accepts<T>): Signal<T> {
  const [get, set] = createSignal<T>(read(key, initial, accepts));
  const setAndStore = ((next: Parameters<typeof set>[0]) => {
    const value = set(next);
    write(key, value);
    return value;
  }) as typeof set;
  return [get, setAndStore];
}

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
export const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
