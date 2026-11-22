import { FilmExport, filmPartKey } from '@imp/mode-movie';
import type { ImpClient } from '@imp/host';
import {
  DownloadSimpleIcon,
  FilmReelIcon,
  FilmSlateIcon,
  PlayIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { ConfirmButton } from './Field.js';
import { saveFileAs } from './save-file.js';
import { currentLanguage, fixed, t, tn, tx } from '../i18n/i18n.js';

export const FilmList = z.object({
  canRender: z.boolean(),
  reason: z.string(),
  exports: z.array(FilmExport),
});
export type FilmList = z.infer<typeof FilmList>;

const CrewNames = z.object({
  crew: z.array(z.object({ roleId: z.string(), name: z.string() })),
});

/** Where a project's rendered films are kept, for watching them change. */
export const filmsPrefix = (projectId: string): string => `projects/${projectId}/movie/exports/`;

/**
 * The rendered films of a movie project, newest first, kept up to date while
 * they render. Pass null outside movie projects.
 */
export function useFilms(projectId: string | null): FilmList | undefined {
  return useLive([projectId === null ? 'no-project/' : filmsPrefix(projectId)], async (imp) =>
    projectId === null
      ? { canRender: false, reason: '', exports: [] }
      : FilmList.parse(await runCommand(imp, 'movie.edit.export.list', { projectId })),
  ).data;
}

/** The name of the crew member whose role made a film. */
export function useMadeBy(): (by: string) => string {
  const crew = useLive(['crew/'], async (imp) =>
    CrewNames.parse(await runCommand(imp, 'crew.list', {})),
  ).data?.crew;
  return (by) => tx(crew?.find((member) => member.roleId === by)?.name ?? by);
}

export function fileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return t('{value} GB', { value: fixed(bytes / 1024 ** 3, 1) });
  if (bytes >= 1024 ** 2) return t('{value} MB', { value: fixed(bytes / 1024 ** 2, 1) });
  return t('{value} KB', { value: String(Math.max(1, Math.round(bytes / 1024))) });
}

/** A film's length as m:ss or h:mm:ss. */
export function filmLength(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${String(minutes)}:${rest}`;
}

/** When a film was made: the time for today's, the day and time for older ones. */
export function madeAt(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    currentLanguage(),
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  ).format(date);
}

/** The stored parts of a rendered film, in order, written to the file one at a time. */
export async function* filmParts(
  imp: ImpClient,
  projectId: string,
  film: FilmExport,
): AsyncGenerator<Uint8Array> {
  if (film.parts === 0) throw new Error(t('Part of the file is missing; render it again.'));
  for (let index = 0; index < film.parts; index++) {
    const part = await imp.blob(filmPartKey(projectId, film.id, index));
    if (part === undefined) throw new Error(t('Part of the file is missing; render it again.'));
    yield part.bytes;
  }
}

/** The whole file of a rendered film, for playing it. */
async function filmFile(imp: ImpClient, projectId: string, film: FilmExport): Promise<Blob> {
  const parts: BlobPart[] = [];
  for await (const part of filmParts(imp, projectId, film)) parts.push(part.slice());
  return new Blob(parts, { type: film.mediaType });
}

/** Asks where to save a rendered film, then writes it there. */
export function saveFilm(imp: ImpClient, projectId: string, film: FilmExport): Promise<unknown> {
  return saveFileAs(
    { suggestedName: film.fileName, mediaType: film.mediaType, description: t('Film') },
    () => filmParts(imp, projectId, film),
  );
}

/** The line under a film's name: when, by whom, how long, how big. */
export function filmFacts(film: FilmExport, madeBy: (by: string) => string): string {
  const when = madeAt(film.finishedAt ?? film.createdAt);
  const who = film.by === 'you' ? t('by you') : t('by {name}', { name: madeBy(film.by) });
  if (film.status === 'rendering') {
    return `${t('Rendering · {done} of {length}', {
      done: filmLength(film.progressSeconds),
      length: filmLength(film.durationSeconds),
    })} · ${who}`;
  }
  if (film.status === 'cancelled') return `${t('Cancelled')} · ${when} · ${who}`;
  if (film.status === 'failed') return `${t('Failed: {error}', { error: film.error })} · ${who}`;
  return t('{when} · {who} · {length} · {width}×{height} {fps} fps · {size}', {
    when,
    who,
    length: filmLength(film.durationSeconds),
    width: String(film.width),
    height: String(film.height),
    fps: String(film.fps),
    size: fileSize(film.sizeBytes),
  });
}

/**
 * One rendered film, with its name, when and by whom it was made, and buttons
 * to play it here and to save it where the person chooses.
 */
export function FilmCard({
  projectId,
  film,
  autoPlay = false,
  deletable = false,
  children,
}: {
  projectId: string;
  film: FilmExport;
  /** Opens the player straight away, as when a notice's Watch button led here. */
  autoPlay?: boolean;
  deletable?: boolean;
  children?: ReactNode;
}): ReactElement {
  const imp = useImp();
  const madeBy = useMadeBy();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  const ready = film.status === 'ready';

  const play = (): void => {
    setError(null);
    setLoading(true);
    filmFile(imp, projectId, film)
      .then((blob) => {
        const next = URL.createObjectURL(blob);
        urlRef.current = next;
        setUrl(next);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setLoading(false);
      });
  };
  useEffect(() => {
    if (autoPlay && ready && urlRef.current === null) play();
  }, [autoPlay, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (): void => {
    setError(null);
    setSaving(true);
    saveFilm(imp, projectId, film)
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <article className="film-card" data-status={film.status} aria-label={film.fileName}>
      <div className="film-card-head">
        <FilmSlateIcon aria-hidden="true" size={22} />
        <div className="stack tight film-card-title">
          <strong>{film.fileName}</strong>
          <span className="muted small mono">{filmFacts(film, madeBy)}</span>
        </div>
      </div>
      {film.status === 'rendering' && (
        <progress
          aria-label={t('Export progress')}
          max={Math.max(1, film.durationSeconds)}
          value={film.progressSeconds}
        />
      )}
      {url !== null && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- the film's own subtitles are burned in
        <video className="film-card-video" src={url} controls autoPlay playsInline />
      )}
      {ready && film.draftsLeftOut.length > 0 && (
        <span className="muted small">
          {tn(
            film.draftsLeftOut.length,
            'Leaves out changes proposed for {count} scene that were not kept yet.',
            'Leaves out changes proposed for {count} scenes that were not kept yet.',
          )}
        </span>
      )}
      {ready && (film.notReady.length > 0 || film.unheard.length > 0) && (
        <span className="muted small">
          {film.notReady.length > 0 &&
            `${tn(film.notReady.length, '{count} item not ready.', '{count} items not ready.')} `}
          {film.unheard.length > 0 && t('Silent: {value}.', { value: film.unheard.join(', ') })}
        </span>
      )}
      {(ready || deletable || children !== undefined) && (
        <div className="row wrap film-card-actions">
          {ready && url === null && (
            <button
              type="button"
              className="button primary small"
              disabled={loading}
              onClick={play}
            >
              <PlayIcon aria-hidden="true" /> {loading ? t('Loading…') : t('Play')}
            </button>
          )}
          {ready && (
            <button type="button" className="button small" disabled={saving} onClick={save}>
              <DownloadSimpleIcon aria-hidden="true" /> {saving ? t('Preparing…') : t('Save as…')}
            </button>
          )}
          {children}
          {deletable && film.status !== 'rendering' && (
            <ConfirmButton
              label={t('Delete')}
              ariaLabel={t('Delete {fileName}', { fileName: film.fileName })}
              question={t('Delete this film?')}
              onConfirm={() => {
                runCommand(imp, 'movie.edit.export.delete', {
                  projectId,
                  exportId: film.id,
                }).catch((cause: unknown) => {
                  setError(messageOf(cause));
                });
              }}
            >
              <TrashIcon aria-hidden="true" />
            </ConfirmButton>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="error small">
          {error}
        </p>
      )}
    </article>
  );
}

// Asking for the library's Films shelf, from a notice or a chat card. The
// library may not be open yet, so the request waits until it is taken.
export const SHOW_FILMS = 'imp:show-films';
let pending: { filmId: string | null } | null = null;

/** Opens the library on its Films shelf, playing `filmId` if one is given. */
export function showFilms(filmId: string | null = null): void {
  pending = { filmId };
  window.dispatchEvent(new CustomEvent(SHOW_FILMS));
}

/** The waiting request for the Films shelf, if any; taking it clears it. */
export function takeFilmsRequest(): { filmId: string | null } | null {
  const request = pending;
  pending = null;
  return request;
}

/** The library's Films shelf: every rendered film of the project, newest first. */
export function FilmShelf({
  projectId,
  query,
  playing,
}: {
  projectId: string;
  query: string;
  /** A film to open the player for straight away. */
  playing: string | null;
}): ReactElement {
  const list = useFilms(projectId);
  const words = query.trim().toLowerCase();
  const films = (list?.exports ?? []).filter(
    (film) => words === '' || `${film.fileName} ${film.label}`.toLowerCase().includes(words),
  );
  return (
    <div className="film-shelf">
      {list !== undefined && films.length === 0 && (
        <div className="library-empty">
          <FilmReelIcon aria-hidden="true" size={36} weight="light" />
          <p>
            {words === ''
              ? t(
                  'No films yet. Export one from the Edit stage, or ask the coordinator or the Film Editor to make one. Every film made lands here.',
                )
              : t('Nothing matches. Try other words or clear a filter.')}
          </p>
        </div>
      )}
      <ul className="film-shelf-list" aria-label={t('Films')}>
        {films.map((film) => (
          <li key={film.id}>
            <FilmCard projectId={projectId} film={film} autoPlay={playing === film.id} deletable />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The number of finished films, for the library's Films tab. */
export function useFilmCount(projectId: string | null): number | undefined {
  return useFilms(projectId)?.exports.filter((film) => film.status === 'ready').length;
}

interface Notice {
  readonly film: FilmExport;
}

/**
 * Tells the person when a crew member finishes rendering a film, or fails to,
 * with buttons to watch it in the library and to save it. Films the person
 * exported themselves are shown in the Export panel instead.
 */
export function FilmNotices({ projectId }: { projectId: string | null }): ReactElement | null {
  const imp = useImp();
  const madeBy = useMadeBy();
  const list = useFilms(projectId);
  const known = useRef<{ projectId: string | null; status: Map<string, string> } | null>(null);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (list === undefined) return;
    const now = new Map(list.exports.map((film) => [film.id, film.status]));
    const before = known.current;
    known.current = { projectId, status: now };
    // What was there when the project opened is not news.
    if (before?.projectId !== projectId) {
      setNotices([]);
      return;
    }
    const fresh = list.exports.filter((film) => {
      if (film.by === 'you' || (film.status !== 'ready' && film.status !== 'failed')) return false;
      const was = before.status.get(film.id);
      return was === undefined || was === 'rendering';
    });
    if (fresh.length > 0) {
      setNotices((current) => [...fresh.map((film) => ({ film })), ...current].slice(0, 3));
    }
  }, [list, projectId]);

  if (projectId === null || notices.length === 0) return null;
  const dismiss = (id: string): void => {
    setNotices((current) => current.filter((notice) => notice.film.id !== id));
  };
  return (
    <div className="film-notices" role="status" aria-live="polite">
      {notices.map(({ film }) => (
        <div key={film.id} className="film-notice" data-status={film.status}>
          {film.status === 'ready' ? (
            <FilmSlateIcon aria-hidden="true" size={22} />
          ) : (
            <WarningIcon aria-hidden="true" size={22} />
          )}
          <span className="film-notice-text">
            {film.status === 'ready' ? (
              <>
                <strong>{t('{name} finished a film', { name: madeBy(film.by) })}</strong>
                <span className="muted small">
                  {film.fileName} · {filmLength(film.durationSeconds)}
                </span>
              </>
            ) : (
              <>
                <strong>{t('{name} could not finish a film', { name: madeBy(film.by) })}</strong>
                <span className="muted small">{film.error}</span>
              </>
            )}
          </span>
          {film.status === 'ready' && (
            <>
              <button
                type="button"
                className="button primary small"
                onClick={() => {
                  dismiss(film.id);
                  showFilms(film.id);
                }}
              >
                <PlayIcon aria-hidden="true" /> {t('Watch')}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  setError(null);
                  saveFilm(imp, projectId, film).catch((cause: unknown) => {
                    setError(messageOf(cause));
                  });
                }}
              >
                <DownloadSimpleIcon aria-hidden="true" /> {t('Save as…')}
              </button>
            </>
          )}
          <button
            type="button"
            className="button quiet icon"
            aria-label={t('Dismiss')}
            title={t('Dismiss')}
            onClick={() => {
              dismiss(film.id);
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
        </div>
      ))}
      {error !== null && (
        <p role="alert" className="error small film-notice">
          {error}
        </p>
      )}
    </div>
  );
}
