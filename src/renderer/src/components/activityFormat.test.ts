import { describe, expect, it } from 'vitest';
import { usd } from '../lib/format';
import { costText } from './activityFormat';

const PRICED_USD = 1.5;

describe('costText', () => {
  it('shows the cost when any request had a price', () => {
    expect(costText({ costUsd: PRICED_USD, requests: 3, unpricedRequests: 1 })).toBe(usd(PRICED_USD));
  });
  it('shows a dash when every request was unpriced', () => {
    expect(costText({ costUsd: 0, requests: 2, unpricedRequests: 2 })).toBe('—');
  });
  it('shows zero cost when there were no requests', () => {
    expect(costText({ costUsd: 0, requests: 0, unpricedRequests: 0 })).toBe(usd(0));
  });
});
