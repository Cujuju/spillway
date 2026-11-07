import { Eye, EyeOff } from 'lucide-solid';
import { Show } from 'solid-js';
import { settings, updateSettings } from '../store';
import { HoverTip } from './ChartTip';

const ICON_PX = 14;

/** Quick toggle for the "Show emails" setting; masking itself happens in the store's snapshot memo. `iconOnly` names it in a tooltip. */
export function ShowEmailsButton(props: { class?: string; iconOnly?: boolean }) {
  const shown = () => settings().dashboard.showEmails;
  const label = () => (shown() ? 'Hide emails' : 'Show emails');
  const button = () => (
    <button
      type="button"
      class={props.class ?? 'btn'}
      aria-pressed={shown()}
      aria-label={props.iconOnly ? label() : undefined}
      onClick={() => void updateSettings((d) => { d.dashboard.showEmails = !d.dashboard.showEmails; })}
    >
      {shown() ? <EyeOff size={ICON_PX} /> : <Eye size={ICON_PX} />}
      <Show when={!props.iconOnly}> {label()}</Show>
    </button>
  );
  return <Show when={props.iconOnly} fallback={button()}><HoverTip title={label()} rows={[]} layout="contents">{button()}</HoverTip></Show>;
}
