import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { ClientSetupState } from '@shared/types';
import { writeFileAtomic } from './settingsStore';

const CHECK_DELAY_MS = 150;
export interface DriftTarget {
  id: string;
  file: string;
  state(): ClientSetupState;
  status?: () => unknown;
  apply?: () => void;
}
interface DriftOptions {
  intentFile: string;
  initialIntent?: string[];
  targets: DriftTarget[];
  mode(): 'warn' | 'reapply';
  targetKey(): string;
  changed(): void;
  warn(id: string): void;
}

/** Intent survives deletion of the config file and its backup. */
export class ClientDrift {
  private intent = new Set<string>();
  private states = '';
  private transitions = new Map<string, string>();
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private options: DriftOptions) {
    if (existsSync(options.intentFile)) {
      const saved: unknown = JSON.parse(readFileSync(options.intentFile, 'utf8'));
      if (Array.isArray(saved)) this.intent = new Set(saved.filter((id): id is string => typeof id === 'string'));
    } else {
      this.intent = new Set(options.initialIntent);
      writeFileAtomic(options.intentFile, JSON.stringify([...this.intent]));
    }
  }

  setIntent(id: string, applied: boolean): void {
    if (applied) this.intent.add(id);
    else this.intent.delete(id);
    this.transitions.delete(id);
    writeFileAtomic(this.options.intentFile, JSON.stringify([...this.intent]));
    this.check();
  }

  monitored(id: string): boolean {
    return this.intent.has(id);
  }

  start(): void {
    this.watchParents();
    this.check();
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.watchParents();
      this.check();
    }, CHECK_DELAY_MS);
  }

  check(): void {
    let repaired = false;
    for (const target of this.options.targets) {
      const state = target.state();
      if (!this.intent.has(target.id) || state === 'applied') {
        this.transitions.delete(target.id);
        continue;
      }
      const transition = JSON.stringify([state, this.options.targetKey(), this.options.mode()]);
      if (this.transitions.get(target.id) === transition) continue;
      this.transitions.set(target.id, transition);
      if (this.options.mode() === 'reapply' && target.apply) {
        try {
          target.apply();
          if (target.state() === 'applied') {
            repaired = true;
            this.transitions.delete(target.id);
            continue;
          }
        } catch {
          // A failed repair warns once until the drift changes or recovers.
        }
        this.transitions.set(target.id, JSON.stringify([target.state(), this.options.targetKey(), this.options.mode()]));
      }
      this.options.warn(target.id);
    }
    const states = JSON.stringify(this.options.targets.map((target) => [target.id, this.monitored(target.id), target.status ? target.status() : target.state()]));
    if (states !== this.states || repaired) {
      this.states = states;
      this.options.changed();
    }
  }

  private watchParents(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    const dirs = new Map<string, Set<string>>();
    for (const { file } of this.options.targets) {
      let dir = path.dirname(file);
      while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      const name = path.relative(dir, file).split(path.sep)[0]!;
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir)!.add(name);
    }
    for (const [dir, names] of dirs) {
      const watcher = watch(dir, (_event, filename) => {
        if (filename === null || names.has(filename.toString())) this.schedule();
      });
      watcher.on('error', () => this.schedule());
      this.watchers.push(watcher);
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
