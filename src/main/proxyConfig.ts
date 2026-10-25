import type { AppSettings } from '@shared/settings';

export interface ProxyConfigInput {
  settings: AppSettings['proxy'];
  managementKey: string;
  clientApiKey: string;
  authDir: string;
}

const LOOPBACK_HOST = '127.0.0.1';
/** Empty host binds every interface (upstream default). */
const ALL_INTERFACES_HOST = '';

/** JSON string literals are valid YAML double-quoted scalars, so paths and keys need no other escaping. */
const q = (value: string) => JSON.stringify(value);

/** Go duration string the proxy expects for routing.session-affinity-ttl. */
export const affinityTtl = (minutes: number) => `${minutes}m`;

/**
 * Builds the app-owned v8 config.yaml. The file is regenerated on every proxy start;
 * keys follow upstream config.example.yaml.
 */
export function buildProxyConfig(input: ProxyConfigInput): string {
  const { settings: p } = input;
  return [
    '# Managed by CLIProxy Desktop. Regenerated on every proxy start; edit settings in the app.',
    'config-version: 8',
    '',
    'server:',
    `  host: ${q(p.allowLan ? ALL_INTERFACES_HOST : LOOPBACK_HOST)}`,
    `  port: ${p.port}`,
    '',
    'management:',
    '  allow-remote: false',
    `  secret-key: ${q(input.managementKey)}`,
    '  disable-control-panel: true',
    '',
    'access:',
    '  api-keys:',
    `    - ${q(input.clientApiKey)}`,
    '',
    'routing:',
    `  strategy: ${q(p.strategy)}`,
    `  session-affinity: ${p.sessionAffinity}`,
    `  session-affinity-ttl: ${q(affinityTtl(p.sessionAffinityTtlMinutes))}`,
    '',
    'oauth:',
    `  auth-dir: ${q(input.authDir)}`,
    '',
  ].join('\n');
}
