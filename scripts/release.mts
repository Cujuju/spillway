/**
 * Signs and publishes update files, by hand (README → Updates):
 *   node scripts/release.mts keygen | sign [dist] | publish [dist] [--dry-run]
 * The private key stays outside the repo: $SPILLWAY_UPDATE_KEY or ~/.config/spillway/update_key.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parse, parseDocument, type Document, type YAMLMap } from 'yaml';
import { publicKeyOf, releaseTag, sha512File, signFile, verifyFile, type SignedFileInfo } from '../src/main/updateRelease.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_KEY_FILE = path.join(ROOT, 'resources', 'update-public-key.pem');
const KEY_FILE = process.env.SPILLWAY_UPDATE_KEY || path.join(os.homedir(), '.config', 'spillway', 'update_key');
/** electron-builder's update listings: Windows, macOS. */
const LISTINGS = ['latest.yml', 'latest-mac.yml'];
/** Owner-only: the private key must not be readable by other users. */
const PRIVATE_KEY_MODE = 0o600;

class ReleaseError extends Error {}
const fail = (msg: string): never => {
  throw new ReleaseError(msg);
};

interface Listing {
  name: string;
  file: string;
  doc: Document;
  version: string;
  entries: YAMLMap[];
}

function readListings(dist: string): Listing[] {
  const found = LISTINGS.filter((name) => existsSync(path.join(dist, name)));
  if (!found.length) fail(`no ${LISTINGS.join(' or ')} in ${dist}; run pnpm package first`);
  return found.map((name) => {
    const file = path.join(dist, name);
    const doc = parseDocument(readFileSync(file, 'utf8'));
    const version = String(doc.get('version') ?? '');
    const files = doc.get('files');
    if (!version || !isSeq(files)) fail(`${file} has no version or files`);
    return { name, file, doc, version, entries: (files as { items: unknown[] }).items.filter(isMap) as YAMLMap[] };
  });
}

const info = (entry: YAMLMap): SignedFileInfo => ({
  url: String(entry.get('url')),
  sha512: String(entry.get('sha512')),
  signature: entry.has('signature') ? String(entry.get('signature')) : undefined,
});

/** Local file for a listed url; GitHub-safe urls have `-` where the built file name has spaces. */
function localFile(dist: string, url: string): string {
  const name = readdirSync(dist).find((f) => f === url || f.replaceAll(' ', '-') === url);
  return name ? path.join(dist, name) : fail(`${url} is listed but not in ${dist}`);
}

function readPublicKey(): string {
  return existsSync(PUBLIC_KEY_FILE) ? readFileSync(PUBLIC_KEY_FILE, 'utf8') : fail(`no ${PUBLIC_KEY_FILE}; run keygen first`);
}

function keygen(): void {
  if (existsSync(KEY_FILE)) fail(`${KEY_FILE} already exists; installed apps trust it, so it is never replaced here`);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, pem, { mode: PRIVATE_KEY_MODE, flag: 'wx' });
  writeFileSync(PUBLIC_KEY_FILE, publicKeyOf(pem));
  console.log(`Private key: ${KEY_FILE} (back it up somewhere safe, outside the repo)`);
  console.log(`Public key:  ${PUBLIC_KEY_FILE} (commit it; builds embed it)`);
}

async function sign(dist: string): Promise<void> {
  if (!existsSync(KEY_FILE)) fail(`no signing key at ${KEY_FILE}; run keygen or set SPILLWAY_UPDATE_KEY`);
  const privatePem = readFileSync(KEY_FILE, 'utf8');
  if (publicKeyOf(privatePem).trim() !== readPublicKey().trim()) fail(`${PUBLIC_KEY_FILE} is not the public half of ${KEY_FILE}`);
  for (const listing of readListings(dist)) {
    for (const entry of listing.entries) {
      const file = info(entry);
      const actual = await sha512File(localFile(dist, file.url));
      if (actual !== file.sha512) fail(`${file.url} does not match its hash in ${listing.name}; was it rebuilt?`);
      entry.set('signature', signFile(privatePem, listing.version, file));
      console.log(`signed ${file.url} (${listing.version})`);
    }
    writeFileSync(listing.file, listing.doc.toString());
  }
}

/** owner/repo from electron-builder.yml `publish`, which also tells installed apps where to look. */
function updatesRepo(): string {
  const config = parse(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')) as { publish?: { owner?: string; repo?: string } };
  const { owner, repo } = config.publish ?? {};
  return owner && repo ? `${owner}/${repo}` : fail('electron-builder.yml has no publish owner and repo');
}

const gh = (args: string[], dryRun: boolean) => {
  console.log(`gh ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  if (!dryRun) execFileSync('gh', args, { stdio: 'inherit' });
};

function releaseExists(repo: string, tag: string): boolean {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function publish(dist: string, dryRun: boolean): Promise<void> {
  const publicPem = readPublicKey();
  const listings = readListings(dist);
  const versions = new Set(listings.map((l) => l.version));
  if (versions.size !== 1) fail(`listings disagree on the version: ${[...versions].join(', ')}`);
  const version = listings[0]!.version;
  const stage = mkdtempSync(path.join(os.tmpdir(), 'spillway-release-'));
  try {
    const assets: string[] = [];
    for (const listing of listings) {
      for (const entry of listing.entries) {
        const file = info(entry);
        const local = localFile(dist, file.url);
        // Re-checked here: what is uploaded is what installed apps will accept.
        const problem = verifyFile(publicPem, version, file, await sha512File(local));
        if (problem) fail(`${file.url}: ${problem}${file.signature ? '' : '; run sign first'}`);
        // Uploaded under the listed (GitHub-safe) name, which is what the app downloads.
        assets.push(path.join(stage, file.url));
        copyFileSync(local, path.join(stage, file.url));
        if (existsSync(`${local}.blockmap`)) {
          copyFileSync(`${local}.blockmap`, path.join(stage, `${file.url}.blockmap`));
          assets.push(path.join(stage, `${file.url}.blockmap`));
        }
      }
      assets.push(listing.file);
    }
    const repo = updatesRepo();
    const tag = releaseTag(version);
    // Windows and macOS files are built on different machines, so the second upload adds to the release.
    if (releaseExists(repo, tag)) gh(['release', 'upload', tag, ...assets, '--repo', repo], dryRun);
    else gh(['release', 'create', tag, ...assets, '--repo', repo, '--title', `Spillway ${version}`, '--notes', `Spillway ${version}`], dryRun);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
const dist = path.resolve(rest.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'dist'));
try {
  if (command === 'keygen') keygen();
  else if (command === 'sign') await sign(dist);
  else if (command === 'publish') await publish(dist, dryRun);
  else fail('usage: node scripts/release.mts keygen | sign [dist] | publish [dist] [--dry-run]');
} catch (err) {
  if (!(err instanceof ReleaseError)) throw err;
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
