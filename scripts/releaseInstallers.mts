import { existsSync } from 'node:fs';
import path from 'node:path';
import { gh, installerFiles, releaseDetails, releaseView, ROOT, type ReleasePlatform } from './releaseShared.mts';

const details = releaseDetails();
if (details.tag !== process.env.RELEASE_TAG) throw new Error('Installer source does not match the requested release.');
const release = releaseView(details.tag);
if (!release || release.isPrerelease) throw new Error('Full installers require an existing stable release.');
const files = installerFiles(process.platform as ReleasePlatform, details.version).map((f) => path.join(ROOT, 'dist', f));
for (const file of files) if (!existsSync(file)) throw new Error(`Missing installer: ${file}`);
gh(['release', 'upload', details.tag, ...files, '--clobber']);
