import { For, Show } from 'solid-js';
import { SectionedPage, type NavGroup } from '../components/SectionedPage';
import { persistedSignal } from '../lib/persisted';
import { TRAY_NAME } from '../lib/platform';

interface Topic {
  id: string;
  /** Short name in the section list. */
  label: string;
  title: string;
  /** The situation the topic answers. */
  when: string;
  steps: string[];
  /** What happens to running conversations, limits and prompt caches. */
  notes: string[];
}

/** Operational how-tos. Routing claims follow the proxy fork's selector (docs/desktop-api.md there). */
const ROUTING: [Topic, ...Topic[]] = [
  {
    id: 'new-conversations',
    label: 'New conversations',
    title: 'Send new conversations to another account',
    when: 'Spend an account, for example before its 5-hour window resets, without moving conversations already running.',
    steps: [
      "Providers → Logins: set that account's Priority above the others.",
      'Set it back when you are done.',
    ],
    notes: [
      'Running conversations stay on their account and keep their prompt cache.',
      'When the account is limited, new conversations fall back to the next priority.',
      'A conversation idle longer than the Affinity lifetime is routed again, like a new one.',
      'Needs Session affinity (Settings → Routing & server). Without it, every request follows priority.',
    ],
  },
  {
    id: 'all-traffic',
    label: 'All traffic',
    title: 'Send everything to one account',
    when: 'Route all of a provider’s traffic to one account, including conversations already running.',
    steps: [
      `In the ${TRAY_NAME} icon's menu, choose Use account and pick the account.`,
      'Pick Automatic to restore normal routing.',
    ],
    notes: [
      'Overrides priority, the routing strategy and session affinity: running conversations move too, and their prompt cache starts over.',
      'While the account is limited or disabled, routing is automatic.',
      'Conversations started during the override stay on that account after you pick Automatic, until their Affinity lifetime runs out.',
      'The choice survives restarts.',
    ],
  },
  {
    id: 'one-conversation',
    label: 'One conversation',
    title: 'Move one conversation',
    when: 'Move a single conversation to another account of the same provider.',
    steps: ['Activity → Requests: on any request from the conversation, choose Move… and pick the account.'],
    notes: [
      'Moves the conversation and its subagents. Its prompt cache starts over on the new account.',
      'Needs Session affinity. Requests marked "moved" show where the conversation came from.',
    ],
  },
  {
    id: 'stop-account',
    label: 'Stop an account',
    title: 'Stop using an account',
    when: 'Take an account out of rotation without removing its login.',
    steps: ['Providers → Logins: turn off Enabled for the account.'],
    notes: ['Conversations on it move to another account at their next request, and their prompt cache starts over.'],
  },
];

const PROXY: Topic[] = [
  {
    id: 'unlock-tool',
    label: 'Unlock a tool',
    title: 'Unlock an outside tool',
    when: 'A tool such as T3 Code’s usage hub can no longer reach the proxy’s management API.',
    steps: ['Proxy → Management lockouts: Reset.'],
    notes: [
      'Wrong management keys lock the tool out for 5 minutes after 5 failures, then 30 minutes after 3 more.',
      'Spillway itself is never locked out.',
    ],
  },
];

const GROUPS = [
  { group: 'Routing', topics: ROUTING },
  { group: 'Proxy', topics: PROXY },
];
const TOPICS = GROUPS.flatMap((g) => g.topics);
const FIRST_TOPIC = ROUTING[0];
const NAV: NavGroup<string>[] = GROUPS.map((g) => ({ group: g.group, items: g.topics }));

const [topicId, setTopicId] = persistedSignal('helpTopic', FIRST_TOPIC.id, TOPICS.map((t) => t.id));

export function Help() {
  const topic = () => TOPICS.find((t) => t.id === topicId()) ?? FIRST_TOPIC;
  return (
    <SectionedPage nav={NAV} section={topic().id} onSelect={setTopicId}>
      <section class="card help-topic">
        <p class="help-when">{topic().when}</p>
        <ol class="help-steps">
          <For each={topic().steps}>{(s) => <li>{s}</li>}</For>
        </ol>
        <Show when={topic().notes.length}>
          <ul class="help-notes">
            <For each={topic().notes}>{(n) => <li>{n}</li>}</For>
          </ul>
        </Show>
      </section>
    </SectionedPage>
  );
}
