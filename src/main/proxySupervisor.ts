import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, renameSync, type WriteStream } from 'node:fs';
import type { LogLine, ProxyStatus } from '@shared/types';
import { appPaths, resolveProxyExecutable } from './paths';
import { buildProxyConfig } from './proxyConfig';
import { getSecrets, getSettings, writeFileAtomic } from './settingsStore';
import { management } from './managementClient';
import { LogBuffer } from './logBuffer';

/** Proxy startup reads config, auth files and model catalogs; well under this on a normal machine. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
/** Time for the shutdown endpoint to flush auth and cooldown state before a hard kill. */
const GRACEFUL_STOP_MS = 8_000;
/** Crash loop guard: give up after this many restarts inside the window below. */
const MAX_CRASH_RESTARTS = 5;
const CRASH_WINDOW_MS = 10 * 60_000;
const RESTART_BACKOFF_BASE_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ProxySupervisor extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopping = false;
  private crashTimes: number[] = [];
  private logFile: WriteStream | null = null;
  readonly logs = new LogBuffer();
  private status: ProxyStatus = {
    state: 'stopped',
    pid: null,
    port: getSettings().proxy.port,
    startedAt: null,
    lastError: null,
    executablePath: null,
    endpoint: '',
  };

  getStatus(): ProxyStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<ProxyStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  private log(stream: LogLine['stream'], text: string): void {
    for (const line of this.logs.push(stream, text)) {
      this.logFile?.write(`${line.at} ${line.stream} ${line.text}
`);
      this.emit('log', line);
    }
  }

  /** One file per run: the previous run is kept as proxy.prev.log for crash diagnosis. */
  private rotateLogFile(): void {
    this.logFile?.end();
    const file = appPaths.proxyLogFile;
    if (existsSync(file)) renameSync(file, file.replace(/\.log$/, '.prev.log'));
    this.logFile = createWriteStream(file, { flags: 'w' });
  }

  isRunning(): boolean {
    return this.status.state === 'running';
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const settings = getSettings();
    const exe = resolveProxyExecutable(settings.proxy.executablePath);
    const port = settings.proxy.port;
    const endpoint = `http://127.0.0.1:${port}`;
    if (!exe) {
      this.setStatus({ state: 'missing-binary', executablePath: null, port, endpoint, lastError: 'Proxy executable not found' });
      return;
    }
    const secrets = getSecrets();
    mkdirSync(appPaths.authDir, { recursive: true });
    writeFileAtomic(appPaths.proxyConfigFile, buildProxyConfig({
      settings: settings.proxy,
      managementKey: secrets.managementKey,
      clientApiKey: secrets.clientApiKey,
      authDir: appPaths.authDir,
    }));
    management.configure(endpoint, secrets.managementKey);
    this.stopping = false;
    this.rotateLogFile();
    this.setStatus({ state: 'starting', executablePath: exe, port, endpoint, lastError: null, pid: null, startedAt: null });
    this.log('app', `starting ${exe} on port ${port}`);

    // -parent-pid makes the proxy exit if this app dies without stopping it.
    const child = spawn(exe, ['-config', appPaths.proxyConfigFile, '-parent-pid', String(process.pid)], {
      cwd: appPaths.proxyDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    child.stdout?.on('data', (d: Buffer) => this.log('stdout', d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => this.log('stderr', d.toString('utf8')));
    child.on('error', (err) => {
      this.log('app', `spawn failed: ${err.message}`);
      this.setStatus({ state: 'crashed', lastError: err.message, pid: null });
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    this.setStatus({ pid: child.pid ?? null });

    if (await this.waitReady(child)) {
      this.setStatus({ state: 'running', startedAt: new Date().toISOString() });
      this.emit('ready');
    }
  }

  private async waitReady(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.proc !== child) return false;
      if (await management.ping()) return true;
      await sleep(READY_POLL_MS);
    }
    this.log('app', `proxy did not answer within ${READY_TIMEOUT_MS / 1000}s`);
    this.setStatus({ lastError: 'Proxy did not become ready' });
    return false;
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc !== child) return;
    this.proc = null;
    this.log('app', `proxy exited (code=${code}, signal=${signal})`);
    if (this.stopping) {
      this.setStatus({ state: 'stopped', pid: null, startedAt: null });
      return;
    }
    this.setStatus({ state: 'crashed', pid: null, startedAt: null, lastError: `Exited with code ${code ?? signal}` });
    this.emit('crashed', code);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!getSettings().proxy.restartOnCrash) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    if (this.crashTimes.length > MAX_CRASH_RESTARTS) {
      this.log('app', `crashed ${this.crashTimes.length} times in ${CRASH_WINDOW_MS / 60_000} min; not restarting`);
      return;
    }
    const backoff = RESTART_BACKOFF_BASE_MS * 2 ** (this.crashTimes.length - 1);
    this.log('app', `restarting in ${backoff} ms`);
    setTimeout(() => {
      if (!this.proc && !this.stopping) void this.start();
    }, backoff);
  }

  async stop(): Promise<void> {
    const child = this.proc;
    if (!child) {
      if (this.status.state !== 'missing-binary') this.setStatus({ state: 'stopped' });
      return;
    }
    this.stopping = true;
    this.setStatus({ state: 'stopping' });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const accepted = await management.shutdown();
    this.log('app', `stopping proxy (graceful request ${accepted ? 'accepted' : 'unavailable'})`);
    const timedOut = await Promise.race([exited.then(() => false), sleep(GRACEFUL_STOP_MS).then(() => true)]);
    if (timedOut && this.proc === child) {
      this.log('app', 'proxy did not exit in time; killing');
      child.kill();
      await exited;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    this.crashTimes = [];
    await this.start();
  }
}

export const proxy = new ProxySupervisor();
