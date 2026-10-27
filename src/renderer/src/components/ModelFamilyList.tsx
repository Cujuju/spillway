import { Check } from 'lucide-solid';
import { For, Show } from 'solid-js';
import type { CredentialModel } from '@shared/types';
import { familyName, groupModelFamilies, type ModelFamily } from '../lib/modelFamilies';
import { providerVar } from '../lib/providers';
import { createCopier } from './ui';

const ICON_PX = 13;

/** Models grouped by family, newest on top. A version badge copies its id; with `onPick`, the newest row and badges pick models instead. */
export function ModelFamilyList(props: {
  models: CredentialModel[];
  provider: string;
  picked?: (id: string) => boolean;
  onPick?: (id: string) => void;
}) {
  const families = () => groupModelFamilies(props.models);
  const copier = createCopier();
  const isPicked = (id: string) => props.picked?.(id) ?? false;

  const head = (f: ModelFamily) => (
    <>
      <span class="model-family-name">{familyName(f)}</span>
      <Show when={f.latest.version.length}>
        <span class="model-family-version">{f.latest.label}</span>
      </Show>
      <span class="model-family-id selectable">{f.latest.model.id}</span>
      <Show when={props.onPick && isPicked(f.latest.model.id)}>
        <Check size={ICON_PX} class="model-family-check" />
      </Show>
    </>
  );

  return (
    <ul class="model-families" style={{ '--card-wash-hue': providerVar(props.provider) }}>
      <For each={families()}>
        {(f) => (
          <li class="model-family card-wash" classList={{ picked: !!props.onPick && isPicked(f.latest.model.id) }}>
            <Show when={props.onPick} fallback={<div class="model-family-head">{head(f)}</div>}>
              {(pick) => (
                <button type="button" class="model-family-head model-pick" title={`Use ${f.latest.model.id}`} onClick={() => pick()(f.latest.model.id)}>
                  {head(f)}
                </button>
              )}
            </Show>
            <Show when={f.older.length}>
              <div class="model-family-older">
                <For each={f.older}>
                  {(v) => (
                    <Show
                      when={props.onPick}
                      fallback={
                        <button
                          type="button"
                          class="badge"
                          classList={{ copied: copier.copied() === v.model.id }}
                          title={copier.copied() === v.model.id ? 'Copied' : `Copy ${v.model.id}`}
                          onClick={() => void copier.copy(v.model.id)}
                        >
                          {v.label}
                        </button>
                      }
                    >
                      {(pick) => (
                        <button type="button" class="badge" classList={{ accent: isPicked(v.model.id) }} title={`Use ${v.model.id}`} onClick={() => pick()(v.model.id)}>
                          {v.label}
                        </button>
                      )}
                    </Show>
                  )}
                </For>
              </div>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}
