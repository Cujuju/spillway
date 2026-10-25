import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicKeyOf, sha512File, signFile, verifyFile } from './updateRelease';

const pair = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privatePem: pem, publicPem: publicKeyOf(pem) };
};

describe('update signatures', () => {
  const key = pair();
  const file = { url: 'CLIProxy-Desktop-Setup-1.2.0.exe', sha512: 'abc==' };
  const signed = { ...file, signature: signFile(key.privatePem, '1.2.0', file) };

  it('accepts a file signed for its version and hash', () => {
    expect(verifyFile(key.publicPem, '1.2.0', signed, 'abc==')).toBeNull();
  });

  it('rejects a different file, version, key, or no signature', () => {
    expect(verifyFile(key.publicPem, '1.2.0', signed, 'other==')).toMatch(/does not match/);
    expect(verifyFile(key.publicPem, '9.9.9', signed, 'abc==')).toMatch(/not valid/);
    expect(verifyFile(pair().publicPem, '1.2.0', signed, 'abc==')).toMatch(/not valid/);
    expect(verifyFile(key.publicPem, '1.2.0', file, 'abc==')).toMatch(/not signed/);
    // A listing whose hash was swapped along with the file.
    expect(verifyFile(key.publicPem, '1.2.0', { ...signed, sha512: 'other==' }, 'other==')).toMatch(/not valid/);
  });

  it('hashes files as base64 SHA-512', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cliproxy-sig-'));
    try {
      const f = path.join(dir, 'a.bin');
      writeFileSync(f, 'hello');
      expect(await sha512File(f)).toBe('m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
