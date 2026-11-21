import { readReleaseNotes } from './git.js';
import type { ReleaseNotes } from './notes.js';

/** The module a build imports to know its own version and what changed. */
export const RELEASE_MODULE = 'virtual:imp-release';
const RESOLVED = `\0${RELEASE_MODULE}`;

/** The part of a Vite plugin this needs, so the package does not depend on Vite. */
export interface ReleasePlugin {
  readonly name: string;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
}

export interface ReleasePluginOptions {
  readonly cwd: string;
  /** Builds for `main` set `IMP_RELEASE=1`; everything else is a preview. */
  readonly release?: boolean;
  /** Replaces reading git. Tests pass fixed notes. */
  readonly read?: () => ReleaseNotes;
}

/**
 * Serves `virtual:imp-release` as the release notes worked out at build time,
 * so the web app, its worker and the local server all carry the same version.
 */
export function releaseNotesPlugin(options: ReleasePluginOptions): ReleasePlugin {
  const read =
    options.read ??
    (() =>
      readReleaseNotes({
        cwd: options.cwd,
        ...(options.release === undefined ? {} : { release: options.release }),
      }));
  let notes: ReleaseNotes | undefined;
  return {
    name: 'imp-release-notes',
    resolveId: (id) => (id === RELEASE_MODULE ? RESOLVED : undefined),
    load: (id) => {
      if (id !== RESOLVED) return undefined;
      notes ??= read();
      return `export default ${JSON.stringify(notes)};`;
    },
  };
}
