/** Coalesce activity bursts while keeping aggregate updates no more than two seconds behind steady traffic. */
const RELOAD_INTERVAL_MS = 2_000;

export function createActivityReload(load: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = () => {
    cancel();
    load();
  };
  return {
    schedule: () => { timer ??= setTimeout(refresh, RELOAD_INTERVAL_MS); },
    refresh,
    cancel,
  };
}
