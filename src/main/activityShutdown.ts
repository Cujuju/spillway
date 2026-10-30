import type { ActivityRpc } from './activityRpc';
/** 25 seconds covers management timeout (10s), proxy grace (8s), and seven seconds for stream/SQLite flushing. */
export const ACTIVITY_QUIT_DEADLINE_MS = 25_000;

/** One budget covers proxy shutdown, stream draining and the worker queue. */
export async function drainActivity(
  stopProxy: () => Promise<void>, stopStream: (drain?: boolean) => Promise<void>,
  rpc: ActivityRpc, report: (message: string) => void = console.error,
): Promise<void> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      report(`[activity] Quit deadline reached: ${rpc.unacknowledgedEvents} unacknowledged events lost.`);
      rpc.cancel();
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
  finally { clearTimeout(timer!); rpc.cancel(); }
}
