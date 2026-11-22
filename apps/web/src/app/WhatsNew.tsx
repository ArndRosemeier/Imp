import { ReleaseEntry } from '@imp/core';
import { ArrowSquareOutIcon, SparkleIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp } from './context.js';
import { currentLanguage, t } from '../i18n/i18n.js';

/** The last version this browser has shown in What's new. */
const SEEN_KEY = 'imp.whatsNew.seen';
const REPOSITORY = 'https://github.com/ArndRosemeier/Imp';

const Changelog = z.object({
  version: z.string(),
  preview: z.boolean(),
  releases: z.array(ReleaseEntry),
});
type Changelog = z.infer<typeof Changelog>;

/** "0.010" as 10, so that versions compare as numbers. */
export function versionNumber(version: string): number {
  return Math.round(Number(version) * 1000);
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Private windows may refuse storage; the dot then shows again next time.
  }
}

/**
 * The versions this person has not looked at yet. Someone who has never
 * opened the panel gets only the latest one marked, not the whole history.
 */
export function unseenVersions(changelog: Changelog, seen: string | null): Set<string> {
  const published = changelog.releases.filter((release) => release.date !== null);
  if (seen === null) return new Set(published.slice(0, 1).map((release) => release.version));
  return new Set(
    published
      .filter((release) => versionNumber(release.version) > versionNumber(seen))
      .map((release) => release.version),
  );
}

function formatDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  return new Intl.DateTimeFormat(currentLanguage(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

/** The version in the top bar, and the panel of what changed that it opens. */
export function WhatsNew(): ReactElement | null {
  const imp = useImp();
  const dialog = useRef<HTMLDialogElement>(null);
  const [changelog, setChangelog] = useState<Changelog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(readSeen);
  // What was new when the panel opened stays marked while it is open.
  const [marked, setMarked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    runCommand(imp, 'app.changelog', {}).then(
      (output) => {
        if (active) setChangelog(Changelog.parse(output));
      },
      (reason: unknown) => {
        if (active) setError(messageOf(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [imp]);

  if (changelog === null) {
    return error === null ? null : (
      <span className="whats-new-error" title={error}>
        {t('Version unknown')}
      </span>
    );
  }

  const unseen = unseenVersions(changelog, seen);
  const open = (): void => {
    setMarked(unseen);
    dialog.current?.showModal();
    writeSeen(changelog.version);
    setSeen(changelog.version);
  };
  const latest = changelog.releases.find((release) => release.version === changelog.version);
  const summary = changelog.preview
    ? t('A preview build, not a published version.')
    : latest === undefined || latest.date === null
      ? t('Every change that lands adds 0.001.')
      : t('Published {date}. Every change that lands adds 0.001.', {
          date: formatDay(latest.date),
        });
  const label =
    unseen.size > 0
      ? t('What’s new in Imp {version}, with changes you have not seen', {
          version: changelog.version,
        })
      : t('What’s new in Imp {version}', { version: changelog.version });

  return (
    <>
      <button
        className="button quiet whats-new"
        data-unseen={unseen.size > 0 ? 'true' : undefined}
        aria-label={label}
        aria-haspopup="dialog"
        title={t('What’s new')}
        onClick={open}
      >
        <SparkleIcon aria-hidden="true" size={18} weight={unseen.size > 0 ? 'fill' : 'regular'} />
        <span className="label">{t('What’s new')}</span>
        <span className="version-tag">
          {changelog.version}
          {changelog.preview && <span className="preview-mark"> {t('preview')}</span>}
        </span>
        {unseen.size > 0 && <span className="whats-new-dot" aria-hidden="true" />}
      </button>
      {/* A tap on the dimmed backdrop closes the panel, as Escape does; a tablet has no Escape key. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
      <dialog
        ref={dialog}
        className="modal wide whats-new-dialog"
        aria-labelledby="whats-new-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <header className="whats-new-head">
          <div className="stack whats-new-heading">
            <span className="eyebrow">{t('What’s new')}</span>
            <h2 id="whats-new-title">
              Imp <span className="whats-new-version">{changelog.version}</span>
            </h2>
            <p className="muted">{summary}</p>
          </div>
          <button
            className="button quiet icon"
            aria-label={t('Close')}
            onClick={() => dialog.current?.close()}
          >
            <XIcon aria-hidden="true" size={18} />
          </button>
        </header>
        {changelog.releases.length === 0 ? (
          <p className="whats-new-empty muted">
            {t('This build was made without its history, so it cannot say what changed.')}
          </p>
        ) : (
          <ol className="releases">
            {changelog.releases.map((release) => {
              const isNew = marked.has(release.version);
              return (
                <li
                  key={release.version}
                  className="release"
                  data-new={isNew ? 'true' : undefined}
                  data-pending={release.date === null ? 'true' : undefined}
                >
                  <div className="release-rail">
                    <span className="release-version">{release.version}</span>
                    <span className="release-date">
                      {release.date === null ? t('Not merged yet') : formatDay(release.date)}
                    </span>
                  </div>
                  <div className="release-body">
                    <h3 className="release-title">
                      {release.title}
                      {isNew && <span className="release-new">{t('New')}</span>}
                    </h3>
                    {release.notes.length > 0 && (
                      <ul className="release-notes">
                        {release.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    )}
                    {release.pr !== undefined && (
                      <a
                        className="release-link"
                        href={`${REPOSITORY}/pull/${String(release.pr)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('Change #{pr}', { pr: release.pr })}{' '}
                        <ArrowSquareOutIcon aria-hidden="true" size={13} />
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </dialog>
    </>
  );
}
