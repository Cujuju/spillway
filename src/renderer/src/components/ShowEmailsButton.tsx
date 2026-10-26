import { Eye, EyeOff } from 'lucide-solid';
import { settings, updateSettings } from '../store';

const ICON_PX = 14;

/** Quick toggle for the "Show emails" setting; masking itself happens in the store's snapshot memo. */
export function ShowEmailsButton(props: { class?: string }) {
  const shown = () => settings().dashboard.showEmails;
  return (
    <button
      class={props.class ?? 'btn'}
      aria-pressed={shown()}
      onClick={() => void updateSettings((d) => { d.dashboard.showEmails = !d.dashboard.showEmails; })}
    >
      {shown() ? <EyeOff size={ICON_PX} /> : <Eye size={ICON_PX} />} {shown() ? 'Hide emails' : 'Show emails'}
    </button>
  );
}
