import { Show, type JSX } from 'solid-js';
import { activityImport } from '../store';
import { Notice } from './ui';

/** A page's title row, its view tabs (`tabs`), then app-wide notices, so they never sit above the title. */
export function PageHeader(props: { class?: string; tabs?: JSX.Element; children: JSX.Element }) {
  return (
    <>
      <header class={props.class ? `dash-header ${props.class}` : 'dash-header'}>{props.children}</header>
      {props.tabs}
      <Show when={activityImport().error}>{(message) => <Notice class="app-notice">{message()}</Notice>}</Show>
    </>
  );
}
