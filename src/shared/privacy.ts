/** "Show emails" off: every email in displayed text is masked, for screenshots and streams. */

import type { Credential, UsageSnapshot } from './types';

/** An email-like run, also inside auth file names such as "claude-name@example.com.json". */
const EMAIL_RUN = /[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+/g;
const VISIBLE_LOCAL_CHARS = 2;

/** "someone@example.com" → "so…@example.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  return `${email.slice(0, Math.min(VISIBLE_LOCAL_CHARS, at))}…${email.slice(at)}`;
}

export const maskEmails = (text: string): string => text.replace(EMAIL_RUN, maskEmail);

const maybe = (text: string | null) => (text === null ? null : maskEmails(text));

/** Every human-readable account field masked; ids and numbers untouched. */
export function maskCredential(c: Credential): Credential {
  return { ...c, name: maskEmails(c.name), label: maskEmails(c.label), note: maybe(c.note), email: maybe(c.email), statusMessage: maybe(c.statusMessage) };
}

export const maskSnapshot = (s: UsageSnapshot): UsageSnapshot => ({ ...s, credentials: s.credentials.map(maskCredential) });
