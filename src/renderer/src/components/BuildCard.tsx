import type { BuildInfo } from '@shared/buildInfo';
import { createResource, Show } from 'solid-js';
import { proxyStatus } from '../store';
import { proxyStateLabel } from './ProxyState';

/** Sidebar footer: Spillway's version and build, and the running proxy's. */
export function BuildCard() {
  const [app] = createResource(() => window.api.appBuild());
  return (
    <div class="build-card">
      <BuildRow name="Spillway" about={(v) => `Spillway ${v}`} info={app() ?? null} absent="" />
      <BuildRow name="Proxy" about={(v) => `Based on upstream CLIProxyAPI ${v}`} info={proxyStatus()?.build ?? null} absent={proxyStateLabel()} />
    </div>
  );
}

const tooltip = (about: (version: string) => string, info: BuildInfo | null): string | undefined => {
  if (!info) return undefined;
  const lines = [about(info.version)];
  if (info.build) lines.push(`Build ${info.build}${info.modified ? ', with uncommitted changes' : ''}`);
  if (info.builtAt) lines.push(`Built ${new Date(info.builtAt).toLocaleString()}`);
  return lines.join('\n');
};

/** `about` words the version for the tooltip; `absent` fills the line while there is no build to show. */
function BuildRow(props: { name: string; about: (version: string) => string; info: BuildInfo | null; absent: string }) {
  return (
    <div class="build-row" title={tooltip(props.about, props.info)}>
      <div class="build-title">
        {props.name}
        <span class="build-version">{props.info?.version ?? '—'}</span>
      </div>
      <div class="build-sub">
        <Show when={props.info} fallback={props.absent}>
          {(info) => (
            <>
              {info().build ? `build ${info().build}` : 'unstamped build'}
              <Show when={info().modified}>
                <span class="build-modified"> · modified</span>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
