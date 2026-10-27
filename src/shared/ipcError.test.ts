import { describe, expect, it } from 'vitest';
import { remoteMessage, unwrapRemoteError } from './ipcError';

describe('remoteMessage', () => {
  it("strips Electron's invoke prefix", () => {
    expect(remoteMessage("Error invoking remote method 'accounts:add': Error: Login failed")).toBe('Login failed');
  });
  it('keeps a non-generic error name', () => {
    expect(remoteMessage("Error invoking remote method 'x': TypeError: bad")).toBe('TypeError: bad');
  });
  it('leaves other messages alone', () => {
    expect(remoteMessage('Error: plain')).toBe('Error: plain');
  });
});

describe('unwrapRemoteError', () => {
  it('rethrows the same Error with the clean message', () => {
    const original = new Error("Error invoking remote method 'x': Error: nope");
    expect(() => unwrapRemoteError(original)).toThrow(original);
    expect(original.message).toBe('nope');
  });
});
