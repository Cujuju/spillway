/** OAuth providers the proxy can sign in to (v8 /oauth/auth-url `provider` values). */
export const OAUTH_PROVIDERS = [
  { id: 'claude', label: 'Claude', hint: 'Claude Pro / Max subscription' },
  { id: 'codex', label: 'Codex', hint: 'ChatGPT Plus / Pro subscription' },
  { id: 'antigravity', label: 'Antigravity', hint: 'Google account' },
  { id: 'xai', label: 'xAI', hint: 'Grok subscription' },
  { id: 'kimi', label: 'Kimi', hint: 'kimi.com account' },
  { id: 'kimi-ai', label: 'Kimi.ai', hint: 'kimi.ai account' },
  { id: 'devin', label: 'Devin', hint: 'Devin account' },
  { id: 'meta', label: 'Muse (Meta)', hint: 'Meta account' },
] as const;

import antigravity from '../assets/providers/antigravity.svg?raw';
import claude from '../assets/providers/claude.svg?raw';
import codex from '../assets/providers/codex.svg?raw';
import devin from '../assets/providers/devin.svg?raw';
import gemini from '../assets/providers/gemini.svg?raw';
import kimi from '../assets/providers/kimi.svg?raw';
import meta from '../assets/providers/meta.svg?raw';
import xai from '../assets/providers/xai.svg?raw';

const KNOWN = new Set(['claude', 'codex', 'antigravity', 'xai', 'kimi', 'devin', 'meta', 'gemini']);

/** Brand marks as SVG markup, keyed by provider id. kimi.ai shares Kimi's mark. */
const LOGOS: Record<string, string> = { claude, codex, antigravity, xai, kimi, 'kimi-ai': kimi, devin, meta, gemini };

/** lobe-icons suffix every gradient/mask id with this (a React useId artifact). */
const LOGO_ID_SUFFIX = '_R_0_';

/** The provider's logo with ids made unique per instance, or undefined when there is none. */
export function providerLogo(provider: string, instanceId: string): string | undefined {
  return LOGOS[provider]?.replaceAll(LOGO_ID_SUFFIX, instanceId);
}

/** CSS colour for a provider, from the --provider-* tokens. */
export function providerColor(provider: string): string {
  const name = KNOWN.has(provider) ? provider : 'other';
  return getComputedStyle(document.documentElement).getPropertyValue(`--provider-${name}`).trim() || '#94a3b8';
}

export function providerVar(provider: string): string {
  return `var(--provider-${KNOWN.has(provider) ? provider : 'other'})`;
}
