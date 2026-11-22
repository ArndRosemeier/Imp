import type { Project } from '@imp/core';
import { FilmExport, filmPartKey } from '@imp/mode-movie';
import { DownloadSimpleIcon, FilmStripIcon, StopIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { z } from 'zod';
import type { ImpClient } from '@imp/host';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { clock } from './cut-player.js';
import { recordingFormat, recordScenes, type Progress } from './export.js';
import { saveFileAs } from './save-file.js';
import { moviePrefix } from './movie.js';
import { FfmpegOffer } from './FfmpegOffer.js';
import { FFMPEG_STATE_KEY } from '@imp/host';
import { fixed, t, tn } from '../i18n/i18n.js';

const Exports = z.object({
  canRender: z.boolean(),
  reason: z.string(),
  exports: z.array(FilmExport),
});

/** How many rendered films the list shows; older ones stay until deleted. */
const SHOWN = 5;

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return t('{value} GB', { value: fixed(bytes / 1024 ** 3, 1) });
  if (bytes >= 1024 ** 2) return t('{value} MB', { value: fixed(bytes / 1024 ** 2, 1) });
  return t('{value} KB', { value: String(Math.max(1, Math.round(bytes / 1024))) });
}

/** The stored parts of a rendered film, in order, written to the file one at a time. */
async function* filmParts(
  imp: ImpClient,
  projectId: string,
  film: FilmExport,
): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < film.parts; index++) {
    const part = await imp.blob(filmPartKey(projectId, film.id, index));
    if (part === undefined) throw new Error(t('Part of the file is missing; render it again.'));
    yield part.bytes;
  }
}

/**
 * Exporting the cut of one scene or the whole film. Where the core can render
 * (WebCodecs), the film is rendered offline in the background, faster than
 * real time, as agents do it; elsewhere the cut is recorded while it plays.
 */
export function ExportBar({
  project,
  sceneId,
  sceneIds,
  onStatus,
}: {
  project: Project;
  sceneId: string | undefined;
  sceneIds: readonly string[];
  /** What is being exported right now, in a few words, or null while nothing is. */
  onStatus?: ((status: string | null) => void) | undefined;
}): ReactElement {
  // ffmpeg arriving on the local server lets it render, so its state is watched too.
  const live = useLive([`${moviePrefix(project)}exports/`, FFMPEG_STATE_KEY], async (imp) =>
    Exports.parse(await runCommand(imp, 'movie.edit.export.list', { projectId: project.id })),
  );
  if (live.data === undefined) return <div className="stack export-bar" />;
  return live.data.canRender ? (
    <RenderedExports
      project={project}
      sceneId={sceneId}
      exports={live.data.exports}
      onStatus={onStatus}
    />
  ) : (
    <RecordedExport project={project} sceneId={sceneId} sceneIds={sceneIds} onStatus={onStatus} />
  );
}

function RenderedExports({
  project,
  sceneId,
  exports,
  onStatus,
}: {
  project: Project;
  sceneId: string | undefined;
  exports: readonly FilmExport[];
  onStatus?: ((status: string | null) => void) | undefined;
}): ReactElement {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const rendering = exports.find((film) => film.status === 'rendering');
  const busy = starting || rendering !== undefined;
  const status =
    rendering === undefined
      ? starting
        ? t('Starting')
        : null
      : `${String(Math.floor((rendering.progressSeconds / Math.max(1, rendering.durationSeconds)) * 100))}%`;
  useEffect(() => {
    onStatus?.(status);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      onStatus?.(null);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const start = (sceneIds: readonly string[] | undefined): void => {
    setError(null);
    setStarting(true);
    runCommand(imp, 'movie.edit.export', {
      projectId: project.id,
      ...(sceneIds === undefined ? {} : { sceneIds }),
    })
      .catch((cause: unknown) => {
        const message = messageOf(cause);
        if (!message.includes('cancelled')) setError(message);
      })
      .finally(() => {
        setStarting(false);
      });
  };
  const act = (id: string, input: Record<string, unknown>): void => {
    runCommand(imp, id, { projectId: project.id, ...input }).catch((cause: unknown) => {
      setError(messageOf(cause));
    });
  };
  const save = (film: FilmExport): void => {
    setSaving(film.id);
    saveFileAs(
      { suggestedName: film.fileName, mediaType: film.mediaType, description: t('Film') },
      () => filmParts(imp, project.id, film),
    )
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setSaving(null);
      });
  };
  const speed = (film: FilmExport): string =>
    film.renderSeconds > 0 && film.progressSeconds > 0
      ? t(' · {value}× real time', {
          value: fixed(film.progressSeconds / film.renderSeconds, 1),
        })
      : '';
  const shown = exports.filter((film) => film.status !== 'rendering').slice(0, SHOWN);

  return (
    <div className="stack export-bar">
      <div className="row wrap">
        <button
          className="button"
          disabled={busy || sceneId === undefined}
          onClick={() => {
            if (sceneId !== undefined) start([sceneId]);
          }}
        >
          <DownloadSimpleIcon aria-hidden="true" /> {t('Export scene')}
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            start(undefined);
          }}
        >
          <FilmStripIcon aria-hidden="true" /> {t('Export film')}
        </button>
        {rendering !== undefined && (
          <>
            <button
              className="button quiet"
              onClick={() => {
                act('movie.edit.export.cancel', { exportId: rendering.id });
              }}
            >
              <StopIcon aria-hidden="true" /> {t('Cancel')}
            </button>
            <progress
              aria-label={t('Export progress')}
              max={Math.max(1, rendering.durationSeconds)}
              value={rendering.progressSeconds}
            />
            <span className="muted mono" role="status">
              {t('Rendering {label} · {progressSeconds} / {durationSeconds}{rendering}', {
                label: rendering.label,
                progressSeconds: clock(rendering.progressSeconds),
                durationSeconds: clock(rendering.durationSeconds),
                rendering: speed(rendering),
              })}
              {rendering.by === 'you' ? '' : ` · ${t('by {name}', { name: rendering.by })}`}
            </span>
          </>
        )}
      </div>
      <p className="muted">
        {t(
          'Films are rendered to MP4 in the background, faster than real time. You can keep working or switch tabs while it runs, and the Film Editor can export too.',
        )}
      </p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="film-exports" aria-label={t('Rendered films')}>
          {shown.map((film) => (
            <li key={film.id} className="film-export">
              <span className="film-export-name">{film.fileName}</span>
              <span className="muted mono">
                {film.status === 'ready'
                  ? t('{durationSeconds} · {width}×{height} {fps} fps · {sizeBytes}', {
                      durationSeconds: clock(film.durationSeconds),
                      width: String(film.width),
                      height: String(film.height),
                      fps: String(film.fps),
                      sizeBytes: size(film.sizeBytes),
                    })
                  : film.status === 'cancelled'
                    ? t('Cancelled')
                    : t('Failed: {error}', { error: film.error })}
                {film.by === 'you' ? '' : ` · ${t('by {name}', { name: film.by })}`}
              </span>
              {film.status === 'ready' && (film.notReady.length > 0 || film.unheard.length > 0) && (
                <span className="muted film-export-note">
                  {film.notReady.length > 0 &&
                    `${tn(film.notReady.length, '{count} item not ready.', '{count} items not ready.')} `}
                  {film.unheard.length > 0 &&
                    t('Silent: {value}.', { value: film.unheard.join(', ') })}
                </span>
              )}
              <span className="row film-export-actions">
                {film.status === 'ready' && (
                  <button
                    className="button small"
                    disabled={saving !== null}
                    onClick={() => {
                      save(film);
                    }}
                  >
                    <DownloadSimpleIcon aria-hidden="true" />{' '}
                    {saving === film.id ? t('Preparing…') : t('Download')}
                  </button>
                )}
                <button
                  className="button small icon danger-quiet"
                  aria-label={t('Delete {fileName}', { fileName: film.fileName })}
                  title={t('Delete')}
                  onClick={() => {
                    act('movie.edit.export.delete', { exportId: film.id });
                  }}
                >
                  <TrashIcon aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Records the cut while it plays, for browsers that cannot render offline. */
function RecordedExport({
  project,
  sceneId,
  sceneIds,
  onStatus,
}: {
  project: Project;
  sceneId: string | undefined;
  sceneIds: readonly string[];
  onStatus?: ((status: string | null) => void) | undefined;
}): ReactElement {
  const imp = useImp();
  const format = recordingFormat();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = progress !== null;
  const status =
    progress === null
      ? null
      : `${String(Math.floor((progress.seconds / Math.max(1, progress.totalSeconds)) * 100))}%`;
  useEffect(() => {
    onStatus?.(status);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      onStatus?.(null);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const start = (ids: readonly string[], label: string): void => {
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setDone(null);
    setProgress({ scene: 0, scenes: ids.length, seconds: 0, totalSeconds: 0 });
    let seconds = 0;
    const extension = format?.extension ?? 'webm';
    saveFileAs(
      {
        suggestedName: `${project.name.replace(/[^\w.-]+/g, '-')}-${label}.${extension}`,
        mediaType: format?.mimeType.split(';')[0] ?? 'video/webm',
        description: t('Film'),
      },
      async () => {
        const recording = await recordScenes(imp, project.id, ids, setProgress, controller.signal);
        seconds = recording.seconds;
        return recording.blob;
      },
    )
      .then((outcome) => {
        if (outcome.saved)
          setDone(t('Saved {name} ({seconds}).', { name: outcome.name, seconds: clock(seconds) }));
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setProgress(null);
      });
  };

  return (
    <div className="stack export-bar">
      <div className="row wrap">
        <button
          className="button"
          disabled={running || format === null || sceneId === undefined}
          onClick={() => {
            if (sceneId !== undefined) start([sceneId], 'scene');
          }}
        >
          <DownloadSimpleIcon aria-hidden="true" /> {t('Export scene')}
        </button>
        <button
          className="button"
          disabled={running || format === null || sceneIds.length === 0}
          onClick={() => {
            start(sceneIds, 'film');
          }}
        >
          <FilmStripIcon aria-hidden="true" /> {t('Export film')}
        </button>
        {running && (
          <>
            <button
              className="button quiet"
              onClick={() => {
                abort.current?.abort();
              }}
            >
              <StopIcon aria-hidden="true" /> {t('Cancel')}
            </button>
            <progress
              aria-label={t('Export progress')}
              max={Math.max(1, progress.totalSeconds)}
              value={progress.seconds}
            />
            <span className="muted mono" role="status">
              {t('Scene {scene} of {scenes} · {seconds} / {totalSeconds}', {
                scene: String(progress.scene),
                scenes: String(progress.scenes),
                seconds: clock(progress.seconds),
                totalSeconds: clock(progress.totalSeconds),
              })}
            </span>
          </>
        )}
      </div>
      <FfmpegOffer compact />
      <p className="muted">
        {format === null
          ? t('This browser cannot record video. Try a current Chrome, Edge or Safari.')
          : t(
              'Films cannot be rendered in the background here, so the cut is played through once in real time and recorded as {value}. Keep this tab visible until it finishes.',
              { value: format.extension.toUpperCase() },
            )}
      </p>
      {done !== null && <p role="status">{done}</p>}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
