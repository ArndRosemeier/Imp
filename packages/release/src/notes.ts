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
  /** The title and notes in other languages, by language id, where the entry has them. */
  readonly translations?: Readonly<Record<string, Translation>>;
}

/** An entry in another language: `changes/<name>.<language>.md` beside `changes/<name>.md`. */
export interface Translation {
  readonly title: string;
  readonly notes: readonly string[];
}

/** The languages entries are translated into, beside English. */
export const TRANSLATED_LANGUAGES = ['de'] as const;

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
  return (
    path.startsWith(`${CHANGES_DIR}/`) &&
    path.endsWith('.md') &&
    path !== CHANGES_README &&
    translationLanguage(path) === undefined
  );
}

const TRANSLATION = /\.([a-z]{2})\.md$/;

/** "changes/x.de.md" is a translation into German; English entries have no language in the name. */
export function translationLanguage(path: string): string | undefined {
  return TRANSLATION.exec(path)?.[1];
}

/** Where the translation of an entry into a language lives. */
export function translationPath(entry: string, language: string): string {
  return entry.replace(/\.md$/, `.${language}.md`);
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
  language?: string,
): { title?: string; notes: string[] } {
  let title: string | undefined;
  const notes: string[] = [];
  for (const entry of [...paths].filter(isEntry).sort()) {
    const text = read(language === undefined ? entry : translationPath(entry, language));
    if (text === undefined) continue;
    const parsed = parseEntry(text);
    title ??= parsed.title;
    notes.push(...parsed.notes);
  }
  return title === undefined ? { notes } : { title, notes };
}

/**
 * The entry in every language it was translated into. A translation without
 * a title of its own keeps the English one.
 */
function translationsOf(
  paths: readonly string[],
  read: (path: string) => string | undefined,
  englishTitle: string,
): Record<string, Translation> | undefined {
  const result: Record<string, Translation> = {};
  for (const language of TRANSLATED_LANGUAGES) {
    const entry = notesOf(paths, read, language);
    if (entry.title === undefined && entry.notes.length === 0) continue;
    result[language] = { title: entry.title ?? englishTitle, notes: entry.notes };
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/** Turns the history into the versions people read, newest first. */
export function buildReleaseNotes(options: BuildOptions): ReleaseNotes {
  const releases: Release[] = options.merges.map((merge, index) => {
    const subject = splitSubject(merge.subject);
    const entry = notesOf(merge.added, options.read);
    const title = entry.title ?? subject.title;
    const translations = translationsOf(merge.added, options.read, title);
    return {
      version: formatVersion(index + 1),
      date: merge.date.slice(0, 10),
      title,
      ...(subject.pr === undefined ? {} : { pr: subject.pr }),
      notes: entry.notes,
      ...(translations === undefined ? {} : { translations }),
    };
  });
  const latest = releases.at(-1);
  if (options.preview && options.pending !== undefined && options.pending.length > 0) {
    const entry = notesOf(options.pending, options.read);
    if (entry.notes.length > 0 || entry.title !== undefined) {
      const title = entry.title ?? 'Not merged yet';
      const translations = translationsOf(options.pending, options.read, title);
      releases.push({
        version: formatVersion(releases.length + 1),
        date: null,
        title,
        notes: entry.notes,
        ...(translations === undefined ? {} : { translations }),
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
