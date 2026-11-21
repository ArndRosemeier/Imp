export {
  buildReleaseNotes,
  CHANGES_DIR,
  CHANGES_README,
  formatVersion,
  isEntry,
  parseEntry,
  splitSubject,
  UNVERSIONED,
  type BuildOptions,
  type MergeRecord,
  type Release,
  type ReleaseNotes,
} from './notes.js';
export { readReleaseNotes, type ReadOptions } from './git.js';
export {
  RELEASE_MODULE,
  releaseNotesPlugin,
  type ReleasePlugin,
  type ReleasePluginOptions,
} from './vite.js';
