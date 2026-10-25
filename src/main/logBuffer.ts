import type { LogLine } from '@shared/types';

/** Enough to cover a startup plus recent activity without unbounded memory. */
const MAX_LINES = 2000;

/** Keeps the most recent proxy output lines, split on newlines across chunk boundaries. */
export class LogBuffer {
  private lines: LogLine[] = [];
  private partial: Record<LogLine['stream'], string> = { stdout: '', stderr: '', app: '' };

  push(stream: LogLine['stream'], chunk: string): LogLine[] {
    const text = this.partial[stream] + chunk;
    const parts = text.split(/\r?\n/);
    this.partial[stream] = stream === 'app' ? '' : (parts.pop() ?? '');
    const at = new Date().toISOString();
    const added = parts.filter((p) => p.length > 0).map((p) => ({ at, stream, text: p }));
    this.lines.push(...added);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    return added;
  }

  all(): LogLine[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }
}
