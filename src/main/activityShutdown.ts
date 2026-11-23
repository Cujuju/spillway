import type { ActivityRpc } from './activityRpc';
type DrainableRpc = Pick<ActivityRpc, 'unacknowledgedEvents' | 'close' | 'abandon'>;
/** 25 seconds covers management timeout (10s), proxy grace (8s), and seven seconds for stream/SQLite flushing. */
export const ACTIVITY_QUIT_DEADLINE_MS = 25_000;
/** After the deadline, how long the worker may take to close before it is terminated. */
export const ACTIVITY_WORKER_CLOSE_GRACE_MS = 3_000;

/** One budget covers proxy shutdown, stream draining and the worker queue. */
export async function drainActivity(
  stopProxy: () => Promise<void>, stopStream: (drain?: boolean) => Promise<void>,
  rpc: DrainableRpc, report: (message: string) => void = console.error,
): Promise<boolean> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      report(`[activity] Quit deadline reached: ${rpc.unacknowledgedEvents} unacknowledged events lost.`);
      void stopStream(false).catch(console.error);
      resolve();
    }, ACTIVITY_QUIT_DEADLINE_MS);
  });
  const drain = async () => {
    await stopProxy().catch(console.error);
    if (expired) return;
    await stopStream(true);
    if (!expired) await rpc.close();
  };
  try { await Promise.race([drain(), deadline]); }
  finally {
    clearTimeout(timer!);
    await rpc.abandon(ACTIVITY_WORKER_CLOSE_GRACE_MS);
  }
  return !expired;
}
