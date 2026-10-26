/** Version and build of one program: Spillway, or the proxy it runs. */
export interface BuildInfo {
  /** Spillway: its git-derived version. Proxy: the newest upstream CLIProxyAPI release tag in the fork build. */
  version: string;
  /** Short commit hash of the source it was built from; null when the binary was not stamped. */
  build: string | null;
  /** Built from a working tree with uncommitted changes, so the hash alone does not identify the code. */
  modified: boolean;
  /** ISO time of the build, when known. */
  builtAt: string | null;
}

/** Ends a build ID made from a modified working tree; git's own `--dirty` convention. */
export const MODIFIED_SUFFIX = '-dirty';

/** Defaults an unstamped CLIProxyAPI binary reports (cmd/server/main.go). */
const UNSTAMPED = new Set(['', 'dev', 'none', 'unknown']);

const stamped = (value: string | null | undefined): string | null => (value == null || UNSTAMPED.has(value) ? null : value);

/** Reads a stamped version, build ID (`<hash>[MODIFIED_SUFFIX]`) and build time. */
export function parseBuildInfo(version: string | null | undefined, buildId: string | null | undefined, builtAt: string | null | undefined): BuildInfo {
  const id = stamped(buildId);
  const modified = id?.endsWith(MODIFIED_SUFFIX) ?? false;
  return {
    version: stamped(version) ?? 'dev',
    build: id && modified ? id.slice(0, -MODIFIED_SUFFIX.length) : id,
    modified,
    builtAt: stamped(builtAt),
  };
}
