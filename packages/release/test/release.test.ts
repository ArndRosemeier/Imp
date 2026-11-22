import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReleaseNotes,
  formatVersion,
  isEntry,
  parseEntry,
  readReleaseNotes,
  RELEASE_MODULE,
  releaseNotesPlugin,
  splitSubject,
  TRANSLATED_LANGUAGES,
  translationLanguage,
  UNVERSIONED,
} from '../src/index.js';

describe('formatVersion', () => {
  it('counts merges in thousandths', () => {
    expect(formatVersion(0)).toBe('0.000');
    expect(formatVersion(1)).toBe('0.001');
    expect(formatVersion(42)).toBe('0.042');
    expect(formatVersion(999)).toBe('0.999');
    expect(formatVersion(1000)).toBe('1.000');
    expect(formatVersion(1234)).toBe('1.234');
  });

  it('refuses what is not a count', () => {
    expect(() => formatVersion(-1)).toThrow(RangeError);
    expect(() => formatVersion(1.5)).toThrow(RangeError);
  });
});

describe('parseEntry', () => {
  it('reads a title and one note per bullet, joining continued lines', () => {
    expect(
      parseEntry(
        '# Sound you can hear\n\n- Clips play their own sound.\n- Effects can be\n  shaped by region.\n* Star bullets work too.\n',
      ),
    ).toEqual({
      title: 'Sound you can hear',
      notes: [
        'Clips play their own sound.',
        'Effects can be shaped by region.',
        'Star bullets work too.',
      ],
    });
  });

  it('takes plain paragraphs as notes, and later headings as text', () => {
    expect(parseEntry('First line\nof one note.\r\n\r\nSecond note.\n# Not a title')).toEqual({
      notes: ['First line of one note.', 'Second note. # Not a title'],
    });
  });

  it('ignores an empty title and empty bullets', () => {
    expect(parseEntry('# \n-  \n- Real')).toEqual({ notes: ['Real'] });
    expect(parseEntry('')).toEqual({ notes: [] });
  });
});

describe('splitSubject and isEntry', () => {
  it('splits off the pull request number', () => {
    expect(splitSubject('Add sound (#15)')).toEqual({ title: 'Add sound', pr: 15 });
    expect(splitSubject(' Initial commit ')).toEqual({ title: 'Initial commit' });
  });

  it('knows entries from the folder explanation', () => {
    expect(isEntry('changes/sound.md')).toBe(true);
    expect(isEntry('changes/README.md')).toBe(false);
    expect(isEntry('changes/notes.txt')).toBe(false);
    expect(isEntry('docs/sound.md')).toBe(false);
  });

  it('takes a file named for a language as a translation, not an entry', () => {
    expect(isEntry('changes/sound.de.md')).toBe(false);
    expect(translationLanguage('changes/sound.de.md')).toBe('de');
    expect(translationLanguage('changes/sound.md')).toBeUndefined();
  });
});

describe('buildReleaseNotes', () => {
  const files: Record<string, string> = {
    'changes/start.md': '# Imp so far\n- Everything up to now.',
    'changes/b.md': '- Second part.',
    'changes/a.md': '- First part.',
    'changes/next.md': '- Coming soon.',
  };
  const read = (path: string): string | undefined => files[path];
  const merges = [
    {
      hash: 'a1',
      date: '2026-11-21T10:00:00+01:00',
      subject: 'Add versioning (#40)',
      added: ['changes/README.md', 'changes/start.md'],
    },
    { hash: 'b2', date: '2026-11-22T09:00:00Z', subject: 'Fix the timeline (#41)', added: [] },
    {
      hash: 'c3',
      date: '2026-11-23T09:00:00Z',
      subject: 'Direct push',
      added: ['changes/b.md', 'changes/a.md', 'changes/gone.md'],
    },
  ];

  it('numbers merges in order and lists them newest first', () => {
    const notes = buildReleaseNotes({ merges, read, preview: false });
    expect(notes.version).toBe('0.003');
    expect(notes.date).toBe('2026-11-23');
    expect(notes.preview).toBe(false);
    expect(notes.releases).toEqual([
      {
        version: '0.003',
        date: '2026-11-23',
        title: 'Direct push',
        notes: ['First part.', 'Second part.'],
      },
      { version: '0.002', date: '2026-11-22', title: 'Fix the timeline', pr: 41, notes: [] },
      {
        version: '0.001',
        date: '2026-11-21',
        title: 'Imp so far',
        pr: 40,
        notes: ['Everything up to now.'],
      },
    ]);
  });

  it('shows entries not merged yet in previews only', () => {
    const preview = buildReleaseNotes({
      merges,
      read,
      preview: true,
      pending: ['changes/next.md'],
    });
    expect(preview.version).toBe('0.003');
    expect(preview.releases[0]).toEqual({
      version: '0.004',
      date: null,
      title: 'Not merged yet',
      notes: ['Coming soon.'],
    });
    const published = buildReleaseNotes({
      merges,
      read,
      preview: false,
      pending: ['changes/next.md'],
    });
    expect(published.releases).toHaveLength(3);
    const empty = buildReleaseNotes({ merges, read, preview: true, pending: ['changes/gone.md'] });
    expect(empty.releases).toHaveLength(3);
  });

  it('has no version without merges', () => {
    expect(buildReleaseNotes({ merges: [], read, preview: true })).toEqual(UNVERSIONED);
  });

  it('carries the translations of an entry, with the English title where one has none', () => {
    const translated: Record<string, string> = {
      ...files,
      'changes/start.de.md': '# Imp bisher\n- Alles bis jetzt.',
      'changes/a.de.md': '- Erster Teil.',
      'changes/b.de.md': '- Zweiter Teil.',
      'changes/next.de.md': '- Bald.',
    };
    const notes = buildReleaseNotes({
      merges,
      read: (path) => translated[path],
      preview: true,
      pending: ['changes/next.md', 'changes/next.de.md'],
    });
    expect(notes.releases.map((release) => release.translations?.['de'])).toEqual([
      { title: 'Not merged yet', notes: ['Bald.'] },
      { title: 'Direct push', notes: ['Erster Teil.', 'Zweiter Teil.'] },
      undefined,
      { title: 'Imp bisher', notes: ['Alles bis jetzt.'] },
    ]);
  });
});

describe('the entries in this repository', () => {
  const folder = fileURLToPath(new URL('../../../changes/', import.meta.url));
  const names = readdirSync(folder);

  for (const language of TRANSLATED_LANGUAGES) {
    it(`each have a translation into ${language}`, () => {
      // Write changes/<name>.${language}.md beside changes/<name>.md, in the same shape.
      const missing = names
        .filter((name) => isEntry(`changes/${name}`))
        .filter((name) => !names.includes(name.replace(/\.md$/, `.${language}.md`)));
      expect(missing).toEqual([]);
    });

    it(`have no ${language} translation without its entry`, () => {
      const orphans = names
        .filter((name) => translationLanguage(`changes/${name}`) === language)
        .filter((name) => !names.includes(name.replace(`.${language}.md`, '.md')));
      expect(orphans).toEqual([]);
    });
  }
});

describe('readReleaseNotes', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function repository(): {
    dir: string;
    git: (...args: string[]) => string;
    write: (path: string, text: string) => void;
    commit: (subject: string) => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'imp-release-'));
    folders.push(dir);
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
          GIT_COMMITTER_DATE: '2026-11-21T12:00:00Z',
          GIT_AUTHOR_DATE: '2026-11-21T12:00:00Z',
        },
      }).trim();
    git('init', '-q', '-b', 'main');
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const commit = (subject: string): void => {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', subject);
    };
    return { dir, git, write, commit };
  }

  it('counts merges from the one that added the changes folder', () => {
    const { dir, git, write, commit } = repository();
    write('a.txt', 'before');
    // An entry from before versioning began is covered by 0.001's summary, never pending.
    write('changes/old.md', '- Old.');
    commit('Before versioning (#1)');
    write('changes/README.md', '# How');
    write('changes/start.md', '# Imp so far\n- Everything.');
    commit('Add versioning (#2)');
    commit('Plain change (#3)');

    // A pull request's test merge, as CI checks it out: it counts as the next merge.
    git('checkout', '-q', '-b', 'feature');
    write('changes/feature.md', '- A feature.');
    commit('Work in progress');
    write('changes/feature.md', '- A feature, worded better.');
    commit('Reword');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature');

    const notes = readReleaseNotes({ cwd: dir, release: true });
    expect(notes.version).toBe('0.003');
    expect(notes.preview).toBe(false);
    expect(
      notes.releases.map((release) => [release.version, release.title, release.notes]),
    ).toEqual([
      ['0.003', 'Merge feature', ['A feature, worded better.']],
      ['0.002', 'Plain change', []],
      ['0.001', 'Imp so far', ['Everything.']],
    ]);
    expect(notes.releases[2]?.date).toBe('2026-11-21');

    // An entry written but not committed shows as the next version in a preview.
    write('changes/draft.md', '- Draft.');
    const preview = readReleaseNotes({ cwd: join(dir, 'changes') });
    expect(preview.preview).toBe(true);
    expect(preview.releases[0]).toMatchObject({ version: '0.004', date: null, notes: ['Draft.'] });
    expect(preview.releases).toHaveLength(4);
  });

  it('gives previews 0.000 and refuses releases when there is no history to read', () => {
    const outside = mkdtempSync(join(tmpdir(), 'imp-release-none-'));
    folders.push(outside);
    expect(readReleaseNotes({ cwd: outside })).toEqual(UNVERSIONED);
    expect(() => readReleaseNotes({ cwd: outside, release: true })).toThrow(/not a git checkout/);

    const { dir, write, commit } = repository();
    write('a.txt', 'x');
    commit('No versioning yet');
    expect(readReleaseNotes({ cwd: dir })).toEqual(UNVERSIONED);
    expect(() => readReleaseNotes({ cwd: dir, release: true })).toThrow(/changes\/README\.md/);

    write('changes/README.md', '# How');
    commit('Add versioning');
    commit('Next');
    const shallow = mkdtempSync(join(tmpdir(), 'imp-release-shallow-'));
    folders.push(shallow);
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow]);
    expect(readReleaseNotes({ cwd: shallow })).toEqual(UNVERSIONED);
    expect(() => readReleaseNotes({ cwd: shallow, release: true })).toThrow(/shallow/);
  });

  it('copes with the changes folder removed from disk', () => {
    const { dir, write, commit } = repository();
    write('changes/README.md', '# How');
    commit('Add versioning');
    rmSync(join(dir, 'changes'), { recursive: true });
    expect(readReleaseNotes({ cwd: dir }).releases).toEqual([
      { version: '0.001', date: '2026-11-21', title: 'Add versioning', notes: [] },
    ]);
  });
});

describe('releaseNotesPlugin', () => {
  it('serves the notes as a module, reading them once', () => {
    let reads = 0;
    const plugin = releaseNotesPlugin({
      cwd: '.',
      read: () => {
        reads += 1;
        return UNVERSIONED;
      },
    });
    const id = plugin.resolveId(RELEASE_MODULE);
    expect(id).toBeDefined();
    expect(plugin.resolveId('react')).toBeUndefined();
    expect(plugin.load('react')).toBeUndefined();
    const code = plugin.load(id ?? '');
    expect(code).toBe(`export default ${JSON.stringify(UNVERSIONED)};`);
    plugin.load(id ?? '');
    expect(reads).toBe(1);
  });

  it('reads git by default', () => {
    const plugin = releaseNotesPlugin({ cwd: tmpdir(), release: false });
    const id = plugin.resolveId(RELEASE_MODULE) ?? '';
    expect(plugin.load(id)).toContain('"version":"0.000"');
  });
});
