import { ExternalLink } from 'lucide-solid';
import { createResource, For, Show } from 'solid-js';
import { APP_NAME, REPO_URL } from '@shared/app';
import { ACKNOWLEDGEMENTS, CONTRIBUTORS, type Credit } from '../lib/credits';
import { SettingRow, SettingsGroup } from './ui';

const ICON_PX = 14;

/** `https://github.com/a/b` → `github.com/a/b`: the link's visible text. */
const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '');

function LinkButton(props: { url: string; class?: string }) {
  return (
    <button type="button" class={`btn ghost ${props.class ?? ''}`} title={props.url} onClick={() => void window.api.openExternal(props.url)}>
      <ExternalLink size={ICON_PX} /> {shortUrl(props.url)}
    </button>
  );
}

function CreditGroup(props: { title: string; credits: readonly Credit[] }) {
  return (
    <SettingsGroup title={props.title}>
      <For each={props.credits}>
        {(c) => (
          <SettingRow label={c.name} help={c.role}>
            <Show when={c.sponsorUrl}>
              {(url) => (
                <button type="button" class="btn" title={url()} onClick={() => void window.api.openExternal(url())}>
                  <span aria-hidden="true">❤️</span> Sponsor
                </button>
              )}
            </Show>
            <LinkButton url={c.url} />
          </SettingRow>
        )}
      </For>
    </SettingsGroup>
  );
}

/** Spillway's license (LICENSE at the repo root). */
const LICENSE_NAME = 'MIT License';

/** Settings → About: logo, name, version, repository and credits. */
export function AboutSection() {
  const [build] = createResource(() => window.api.appBuild());
  return (
    <>
      <section class="card about-hero">
        <img class="about-logo" src="./logo.png" srcset="./logo.png 1x, ./logo@2x.png 2x, ./logo@3x.png 3x" alt={`${APP_NAME} logo`} />
        <div class="about-text">
          <div class="about-name">{APP_NAME}</div>
          <div class="about-version">
            Version {build()?.version ?? '—'}
            <Show when={build()?.build}>{(b) => <> · build {b()}</>}</Show>
          </div>
          <LinkButton url={REPO_URL} class="about-repo" />
          <div class="about-license">{LICENSE_NAME}</div>
        </div>
      </section>
      <CreditGroup title="Contributors" credits={CONTRIBUTORS} />
      <CreditGroup title="Built on" credits={ACKNOWLEDGEMENTS} />
    </>
  );
}
