export interface CrashWindowConfig {
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly backoffBaseMs: number;
}

export type CrashDecision =
  | { readonly action: 'retry'; readonly delayMs: number }
  | { readonly action: 'give-up'; readonly count: number };

export class CrashWindow {
  private times: number[] = [];

  constructor(private readonly config: CrashWindowConfig) {}

  record(now = Date.now()): CrashDecision {
    const { windowMs, maxAttempts, backoffBaseMs } = this.config;
    this.times = this.times.filter((time) => now - time < windowMs);
    this.times.push(now);
    const count = this.times.length;
    if (count > maxAttempts) return { action: 'give-up', count };
    return { action: 'retry', delayMs: backoffBaseMs * 2 ** (count - 1) };
  }

  reset(): void {
    this.times = [];
  }
}
