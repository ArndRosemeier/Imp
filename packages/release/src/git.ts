import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReleaseNotes,
  CHANGES_DIR,
  CHANGES_README,
  isEntry,
  UNVERSIONED,
  type MergeRecord,
  type ReleaseNotes,
} from './notes.js';

export interface ReadOptions {
  /** Any folder inside the repository. */
  readonly cwd: string;
  /**
   * A build for `main`, to be published. It must have the whole history and
   * fails loudly without it, because a wrong version number would go out.
   */
  readonly release?: boolean;
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/**
 * Reads the versions from the repository's history. Previews without a
 * history (a shallow clone, no git at all) get version 0.000 instead of a
 * failed build; a release does not.
 */
export function readReleaseNotes(options: ReadOptions): ReleaseNotes {
  const release = options.release === true;
  let cwd = options.cwd;
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const unavailable = (reason: string): ReleaseNotes => {
    if (release) throw new Error(`The version cannot be worked out: ${reason}`);
    return UNVERSIONED;
  };

  let root: string;
  try {
    root = git('rev-parse', '--show-toplevel');
  } catch {
    return unavailable('this is not a git checkout.');
  }
  // Paths below are relative to the top of the repository.
  cwd = root;
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    return unavailable('the clone is shallow. Check out with the whole history (fetch-depth: 0).');
  }

  // First-parent with merges diffed against their first parent: on `main` every
  // commit is one squashed pull request, and a pull request's test merge counts
  // as the one merge it will become.
  const line = ['--first-parent', '--diff-merges=first-parent'];
  const added = new Map<string, string[]>();
  for (const record of git(
    'log',
    ...line,
    '--diff-filter=A',
    '--name-only',
    `--format=${RECORD}%H`,
    '--',
    CHANGES_DIR,
  ).split(RECORD)) {
    const [hash, ...paths] = record.split('\n').map((part) => part.trim());
    if (hash !== undefined && hash !== '') {
      added.set(
        hash,
        paths.filter((path) => path !== ''),
      );
    }
  }

  // The history lists newest first, so the last merge that added the README is the first one.
  const start = [...added].filter(([, paths]) => paths.includes(CHANGES_README)).at(-1)?.[0];
  if (start === undefined) return unavailable(`nothing has added ${CHANGES_README} yet.`);

  const merges: MergeRecord[] = [];
  let begun = false;
  for (const entry of git(
    'log',
    '--first-parent',
    '--reverse',
    `--format=%H${FIELD}%cI${FIELD}%s`,
  ).split('\n')) {
    const [hash = '', date = '', subject = ''] = entry.split(FIELD);
    begun ||= hash === start;
    if (begun) merges.push({ hash, date, subject, added: added.get(hash) ?? [] });
  }

  const read = (path: string): string | undefined => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  // Only entries not committed at all are pending. Committed ones from before
  // versioning began belong to 0.001, whose summary covers them.
  const tracked = new Set(git('ls-files', '--', CHANGES_DIR).split('\n'));
  let onDisk: string[];
  try {
    onDisk = readdirSync(join(root, CHANGES_DIR)).map((name) => `${CHANGES_DIR}/${name}`);
  } catch {
    onDisk = [];
  }
  return buildReleaseNotes({
    merges,
    read,
    pending: onDisk.filter((path) => isEntry(path) && !tracked.has(path)),
    preview: !release,
  });
}
