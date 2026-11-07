import { describe, expect, it } from 'vitest';
import { attemptStatus, modelLabel, nodeLabel } from './traceFormat';

describe('traceFormat', () => {
  it('collapses a model routed to itself', () => {
    expect(modelLabel('claude-opus-5-5 → claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelLabel('gpt-6 → gpt-6-luna')).toBe('gpt-6 → gpt-6-luna');
    expect(modelLabel('gpt-6')).toBe('gpt-6');
  });

  it('labels attempts by outcome, then status code', () => {
    expect(attemptStatus({ failed: true, statusCode: 529 })).toEqual({ label: 'Failed 529', tone: 'red' });
    expect(attemptStatus({ failed: false, statusCode: null })).toEqual({ label: 'OK', tone: 'green' });
    expect(attemptStatus({ failed: null, statusCode: null })).toEqual({ label: 'No status', tone: '' });
  });

  it('names sessionless nodes by their trace or attempt ID', () => {
    expect(nodeLabel({ id: 'trace:abcdef0123456789', sessionId: null })).toBe('Exchange abcdef0123');
    expect(nodeLabel({ id: 'attempt:42', sessionId: null })).toBe('Attempt 42');
  });
});
