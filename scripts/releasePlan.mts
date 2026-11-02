import { appendFileSync } from 'node:fs';
import { BUILD_MATRIX, ensureNightlyRelease, gh, git, nightlyTarget, releaseDetails, type ReleaseView } from './releaseShared.mts';

function plan() {
  if (process.env.RELEASE_MODE === 'installers') {
    const tag = process.env.RELEASE_TAG;
    const release = JSON.parse(gh(['release', 'view', ...(tag ? [tag] : []), '--json', 'tagName,isPrerelease'])) as ReleaseView;
    if (release.isPrerelease) throw new Error('Promote the release before publishing full installers.');
    const details = releaseDetails(release.tagName);
    if (details.tag !== release.tagName) throw new Error('The release tag does not match its source version.');
    return { ...details, mode: 'installers', matrix: { include: BUILD_MATRIX } };
  }
  git(['fetch', '--tags', 'origin', 'main']);
  const [latest] = JSON.parse(gh(['release', 'list', '--limit', '1', '--json', 'tagName'])) as { tagName: string }[];
  const newest = latest ? JSON.parse(gh(['release', 'view', latest.tagName, '--json', 'tagName,isPrerelease,assets'])) as ReleaseView : null;
  const released = newest ? git(['rev-list', '-n', '1', newest.tagName]) : null;
  const target = nightlyTarget(git(['rev-parse', 'origin/main']), released, newest, process.env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  if (!target) return null;
  const details = releaseDetails(target.sha);
  // A manual run of an already-stable source has no nightly assets to add.
  if (newest?.tagName === details.tag && !newest.isPrerelease) return null;
  const existing = ensureNightlyRelease(details);
  const builds = BUILD_MATRIX.filter((b) => target.platforms.includes(b.platform));
  return { ...details, mode: 'nightly', matrix: { include: builds.map((b) => ({ ...b,
    published: existing?.assets.some((a) => a.name === `update-${b.platform}.json`) ?? false,
  })) } };
}

const output = process.env.GITHUB_OUTPUT;
if (!output) throw new Error('GITHUB_OUTPUT is required');
const result = plan();
appendFileSync(output, `run=${Boolean(result)}\n`);
if (result) {
  for (const [key, value] of Object.entries(result)) appendFileSync(output, `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}
