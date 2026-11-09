import { createHash } from 'node:crypto';
import type { RequestSettings } from '@shared/requestSettings';
/** Twelve hex digits keep markers compact within this local database. */
const SETTINGS_HASH_LENGTH = 12;
export function requestSettingsHash(s: RequestSettings): string {
  return createHash('sha256').update(JSON.stringify({ betas: [...new Set(s.betas)].sort(), maxTokens: s.maxTokens, thinking: s.thinking, thinkingBudget: s.thinkingBudget })).digest('hex').slice(0, SETTINGS_HASH_LENGTH);
}
