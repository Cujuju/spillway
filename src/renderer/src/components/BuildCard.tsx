import { HoverTip, type TipRow } from './ChartTip';
import type { BuildInfo } from '@shared/buildInfo';
import { createResource, Show } from 'solid-js';
import { openSettings, proxyStatus } from '../store';
import { dateTime } from '../lib/format';
import { proxyStateLabel } from './ProxyState';

/** Sidebar footer: Spillway's version and build, and the running proxy's. Opens Updates: the proxy ships inside the app. */
export function BuildCard() {
  const [app] = createResource(() => window.api.appBuild());
  return (
    <HoverTip title="Builds" layout="contents" rows={[
      ...buildRows('Spillway', app() ?? null),
      ...buildRows('Proxy', proxyStatus()?.build ?? null),
    ]}>
      <button type="button" class="build-card" onClick={() => openSettings('updates')}>
        <BuildRow name="Spillway" info={app() ?? null} absent="" />
        <BuildRow name="Proxy" info={proxyStatus()?.build ?? null} absent={proxyStateLabel()} />
      </button>
    </HoverTip>
  );
}

function buildRows(name: string, info: BuildInfo | null): TipRow[] {
  if (!info) return [];
  return [
    { label: name, value: info.version },
    ...(info.build ? [{ label: `${name} build`, value: info.build }] : []),
    { label: `${name} changes`, value: info.modified ? 'Uncommitted changes' : 'None' },
    ...(info.builtAt ? [{ label: `${name} built`, value: dateTime(info.builtAt) }] : []),
  ];
}

/** One version row inside the Updates button. */
function BuildRow(props: { name: string; info: BuildInfo | null; absent: string }) {
  return (
    <span class="build-row">
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
