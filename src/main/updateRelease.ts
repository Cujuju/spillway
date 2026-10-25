/**
 * Release files: tags, hashes and Ed25519 signatures, shared by the app (verify) and scripts/release.mts (sign).
 * Node built-ins only and erasable TypeScript, so Node runs it directly from the release script.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** electron-updater's GitHub provider looks for v-prefixed tags. */
export const releaseTag = (version: string) => `v${version}`;

/** Binds a signature to this app, so a signature made for another app's files never matches. */
const SIGNATURE_CONTEXT = 'cliproxy-desktop-update-v1';

/** One installer listed in latest.yml / latest-mac.yml, plus the signature the release script adds. */
export interface SignedFileInfo {
  url: string;
  /** Base64 SHA-512 of the file, as electron-builder writes it. */
  sha512: string;
  /** Base64 Ed25519 signature over signedMessage(); absent on an unsigned release. */
  signature?: string;
}

/** The version is signed too, so an old installer cannot be relisted as a newer version. */
export function signedMessage(version: string, file: SignedFileInfo): Buffer {
  return Buffer.from([SIGNATURE_CONTEXT, version, file.url, file.sha512].join('\n'), 'utf8');
}

/** Base64 SHA-512 of a file, the format electron-builder uses in latest.yml. */
export function sha512File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

export function signFile(privateKeyPem: string, version: string, file: SignedFileInfo): string {
  // Ed25519 takes no separate digest: the algorithm argument is null.
  return sign(null, signedMessage(version, file), createPrivateKey(privateKeyPem)).toString('base64');
}

export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

function parsePublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The update public key is not an Ed25519 key');
  return key;
}

/**
 * Checks a downloaded file against its listing: its hash must be the listed one and the listing must be
 * signed by `publicKeyPem` for `version`. Returns the reason it failed, or null when it is genuine.
 */
export function verifyFile(publicKeyPem: string, version: string, file: SignedFileInfo, actualSha512: string): string | null {
  if (!file.signature) return 'the update is not signed';
  if (actualSha512 !== file.sha512) return 'the downloaded file does not match the release listing';
  const ok = verify(null, signedMessage(version, file), parsePublicKey(publicKeyPem), Buffer.from(file.signature, 'base64'));
  return ok ? null : 'the update signature is not valid for this app';
}
