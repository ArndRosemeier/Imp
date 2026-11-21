/** This build's version and what changed, worked out from git when it was built. See @imp/release. */
declare module 'virtual:imp-release' {
  import type { ReleaseNotes } from '@imp/core';

  const release: ReleaseNotes;
  export default release;
}
