/**
 * What's new in Imp, worked out from the history of `main` alone.
 *
 * Every commit on the first-parent line of `main` is one merge, and every
 * merge is one version: the merge that started versioning is 0.001, the next
 * 0.002, and so on. Nothing is written back to the repository, so pull
 * requests that merge in parallel never collide over a version number.
 *
 * A pull request describes itself for people by adding a file under
 * `changes/`. Without one, its title stands in.
 */

/** One merge to `main`, as the history records it. */
export interface MergeRecord {
  readonly hash: string;
  /** ISO 8601, as git prints it. */
  readonly date: string;
  readonly subject: string;
  /** The files under `changes/` that this merge added, repository-relative. */
  readonly added: readonly string[];
}

/** One version as people read it. */
export interface Release {
  readonly version: string;
  /** The day it merged, YYYY-MM-DD, or null for changes not merged yet. */
  readonly date: string | null;
  readonly title: string;
  /** The pull request that brought it, when the merge names one. */
  readonly pr?: number;
  /** One plain-language line per change people will notice. */
  readonly notes: readonly string[];
}

export interface ReleaseNotes {
  /** The version this build is. */
  readonly version: string;
  readonly date: string | null;
  /** True for builds that did not come from `main`: development and pull requests. */
  readonly preview: boolean;
  /** Newest first. */
  readonly releases: readonly Release[];
}

/** The folder that holds the entries, and the file whose arrival started versioning. */
export const CHANGES_DIR = 'changes';
export const CHANGES_README = `${CHANGES_DIR}/README.md`;

/** A build with no history to read: the number says plainly that it is unknown. */
export const UNVERSIONED: ReleaseNotes = {
  version: '0.000',
  date: null,
  preview: true,
  releases: [],
};

/** 1 is "0.001"; after 999 merges the count carries into the whole number, 1000 being "1.000". */
export function formatVersion(count: number): string {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`A version counts merges, so ${String(count)} is not one.`);
  }
  return `${String(Math.floor(count / 1000))}.${String(count % 1000).padStart(3, '0')}`;
}

/** Whether `path` is an entry rather than the folder's own explanation or something else. */
export function isEntry(path: string): boolean {
  return path.startsWith(`${CHANGES_DIR}/`) && path.endsWith('.md') && path !== CHANGES_README;
}

const BULLET = /^\s*[-*](?:\s+(.*))?$/;
const HEADING = /^#(?:\s+(.*))?$/;

/**
 * Reads an entry: an optional `# Title` line, then one bullet per change.
 * Lines right under a bullet continue it. Text without bullets counts as one
 * note per paragraph, so a plain sentence works too.
 */
export function parseEntry(markdown: string): { title?: string; notes: string[] } {
  let title: string | undefined;
  const notes: string[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (current !== null && current.length > 0) notes.push(current.join(' '));
    current = null;
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    if (heading !== null && title === undefined && notes.length === 0 && current === null) {
      title = heading[1]?.trim() ?? '';
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flush();
      current = [bullet[1]?.trim() ?? ''];
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // A continuation of the bullet above, or a line of a plain paragraph.
    current ??= [];
    current.push(line.trim());
  }
  flush();
  const cleaned = notes.filter((note) => note !== '');
  return title === undefined || title === '' ? { notes: cleaned } : { title, notes: cleaned };
}

const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;

/** "Add sound (#15)" is the title "Add sound" from pull request 15. */
export function splitSubject(subject: string): { title: string; pr?: number } {
  const match = PR_SUFFIX.exec(subject);
  if (match === null) return { title: subject.trim() };
  return { title: subject.slice(0, match.index).trim(), pr: Number(match[1]) };
}

export interface BuildOptions {
  /**
   * The first-parent history of the build, oldest first, starting with the
   * merge that started versioning.
   */
  readonly merges: readonly MergeRecord[];
  /** Reads an entry by path; undefined when it no longer exists. */
  readonly read: (path: string) => string | undefined;
  /** Entries on disk that no merge added yet. Shown only in previews. */
  readonly pending?: readonly string[];
  readonly preview: boolean;
}

function notesOf(
  paths: readonly string[],
  read: (path: string) => string | undefined,
): { title?: string; notes: string[] } {
  let title: string | undefined;
  const notes: string[] = [];
  for (const path of [...paths].filter(isEntry).sort()) {
    const text = read(path);
    if (text === undefined) continue;
    const entry = parseEntry(text);
    title ??= entry.title;
    notes.push(...entry.notes);
  }
  return title === undefined ? { notes } : { title, notes };
}

/** Turns the history into the versions people read, newest first. */
export function buildReleaseNotes(options: BuildOptions): ReleaseNotes {
  const releases: Release[] = options.merges.map((merge, index) => {
    const subject = splitSubject(merge.subject);
    const entry = notesOf(merge.added, options.read);
    return {
      version: formatVersion(index + 1),
      date: merge.date.slice(0, 10),
      title: entry.title ?? subject.title,
      ...(subject.pr === undefined ? {} : { pr: subject.pr }),
      notes: entry.notes,
    };
  });
  const latest = releases.at(-1);
  if (options.preview && options.pending !== undefined && options.pending.length > 0) {
    const entry = notesOf(options.pending, options.read);
    if (entry.notes.length > 0 || entry.title !== undefined) {
      releases.push({
        version: formatVersion(releases.length + 1),
        date: null,
        title: entry.title ?? 'Not merged yet',
        notes: entry.notes,
      });
    }
  }
  return {
    version: latest?.version ?? UNVERSIONED.version,
    date: latest?.date ?? null,
    preview: options.preview,
    releases: releases.reverse(),
  };
}
