import type { BuildInfo } from '@shared/buildInfo';
import { createResource, Show } from 'solid-js';
import { openSettings, proxyStatus } from '../store';
import { proxyStateLabel } from './ProxyState';

/** Sidebar footer: Spillway's version and build, and the running proxy's. Opens Updates: the proxy ships inside the app. */
export function BuildCard() {
  const [app] = createResource(() => window.api.appBuild());
  return (
    <button type="button" class="build-card" onClick={() => openSettings('updates')}>
      <BuildRow name="Spillway" about={(v) => `Spillway ${v}`} info={app() ?? null} absent="" />
      <BuildRow name="Proxy" about={(v) => `Based on upstream CLIProxyAPI ${v}`} info={proxyStatus()?.build ?? null} absent={proxyStateLabel()} />
    </button>
  );
}

const tooltip = (about: (version: string) => string, info: BuildInfo | null): string | undefined => {
  if (!info) return undefined;
  const lines = [about(info.version)];
  if (info.build) lines.push(`Build ${info.build}${info.modified ? ', with uncommitted changes' : ''}`);
  if (info.builtAt) lines.push(`Built ${new Date(info.builtAt).toLocaleString()}`);
  return lines.join('\n');
};

/** `about` words the version for the tooltip; `absent` fills the line while there is no build to show. Spans only: it sits in a button. */
function BuildRow(props: { name: string; about: (version: string) => string; info: BuildInfo | null; absent: string }) {
  return (
    <span class="build-row" title={tooltip(props.about, props.info)}>
      <span class="build-title">
        {props.name}
        <span class="build-version">{props.info?.version ?? '—'}</span>
      </span>
      <span class="build-sub">
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
      </span>
    </span>
  );
}
