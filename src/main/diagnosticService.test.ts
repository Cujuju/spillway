import { afterAll, expect, it, vi } from 'vitest';
import type { DiagnosticDependencies } from './diagnosticExport';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { DiagnosticSanitizer } from './diagnosticSanitize';

const captured = vi.hoisted(() => ({ context: null as DiagnosticDependencies['context'] | null }));
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' }, dialog: {} }));
vi.mock('./activityService', () => ({ activityLog: { call: async () => ({ policy: DEFAULT_ARCHIVE_POLICY }) } }));
vi.mock('./settingsStore', () => ({
  getSettings: () => DEFAULT_SETTINGS,
  getSecrets: () => ({ clientApiKey: 'client-literal-key', managementKey: 'management-literal-key', databaseKey: 'database-literal-key', clickhouse: { username: 'archive-operator', password: 'p.a$s', endpoint: 'http://localhost:8123' } }),
}));
vi.mock('./proxySupervisor', () => ({ proxy: { logs: { all: () => [] }, getStatus: () => ({ state: 'stopped' }) } }));
vi.mock('./proxyIdentity', () => ({ proxyIdentity: () => ({ clientApiKeys: ['production-client-key'], managementKey: 'production-management-key' }) }));
vi.mock('./window', () => ({ mainWindow: () => undefined }));
vi.mock('./diagnosticWorker?modulePath', () => ({ default: '/unused/diagnostic-worker.js' }));
vi.mock('./diagnosticExport', () => ({ DiagnosticExporter: class {
  constructor(dependencies: DiagnosticDependencies) { captured.context = dependencies.context; }
  expire(): void {}
  async shutdown(): Promise<void> {}
} }));
import { stopDiagnosticExport } from './diagnosticService';

afterAll(async () => { await stopDiagnosticExport(); vi.unstubAllGlobals(); });

it('redacts nested ClickHouse credentials from inspected text alongside existing local and production keys', async () => {
  vi.stubGlobal('__APP_BUILD__', 'test-build');
  const context = await captured.context!();
  const secrets = ['archive-operator', 'p.a$s', 'client-literal-key', 'management-literal-key', 'database-literal-key', 'production-client-key', 'production-management-key'];
  expect(context.knownSecrets.every((value) => typeof value === 'string')).toBe(true);
  for (const secret of secrets) expect(context.knownSecrets).toContain(secret);
  const text = new DiagnosticSanitizer(context.knownSecrets).text(`safe phrase ${secrets.join(' / ')}`);
  expect(text).toContain('safe phrase');
  for (const secret of secrets) expect(text).not.toContain(secret);
});

it('treats short and normalized secrets literally without reprocessing replacements or matching empty strings', () => {
  const sanitizer = new DiagnosticSanitizer(['a', 'redacted', 'p.a$s', '\u202a\u202b\u202c\u2066\u2067\u2068\u2069\u001b']);
  expect(sanitizer.text('p.a$s a')).toBe('[redacted] [redacted]');
  expect(sanitizer.text('pXaYs')).toBe('pX[redacted]Ys');
});
