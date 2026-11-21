import type { Project } from '@imp/core';
import { FilmExport, filmPartKey } from '@imp/mode-movie';
import { DownloadSimpleIcon, FilmStripIcon, StopIcon, TrashIcon } from '@phosphor-icons/react';
import { useRef, useState, type ReactElement } from 'react';
import { z } from 'zod';
import type { ImpClient } from '@imp/host';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { clock } from './cut-player.js';
import { download, recordingFormat, recordScenes, type Progress } from './export.js';
import { moviePrefix } from './movie.js';

const Exports = z.object({
  canRender: z.boolean(),
  reason: z.string(),
  exports: z.array(FilmExport),
});

/** How many rendered films the list shows; older ones stay until deleted. */
const SHOWN = 5;

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/** The stored parts of a rendered film, joined into one file for the browser's download. */
async function filmFile(imp: ImpClient, projectId: string, film: FilmExport): Promise<Blob> {
  const parts: BlobPart[] = [];
  for (let index = 0; index < film.parts; index++) {
    const part = await imp.blob(filmPartKey(projectId, film.id, index), true);
    if (part === undefined) throw new Error('Part of the file is missing; render it again.');
    parts.push(part.bytes.slice());
  }
  return new Blob(parts, { type: film.mediaType });
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
}: {
  project: Project;
  sceneId: string | undefined;
  sceneIds: readonly string[];
}): ReactElement {
  const live = useLive([`${moviePrefix(project)}exports/`], async (imp) =>
    Exports.parse(await runCommand(imp, 'movie.edit.export.list', { projectId: project.id })),
  );
  if (live.data === undefined) return <div className="stack export-bar" />;
  return live.data.canRender ? (
    <RenderedExports project={project} sceneId={sceneId} exports={live.data.exports} />
  ) : (
    <RecordedExport project={project} sceneId={sceneId} sceneIds={sceneIds} />
  );
}

function RenderedExports({
  project,
  sceneId,
  exports,
}: {
  project: Project;
  sceneId: string | undefined;
  exports: readonly FilmExport[];
}): ReactElement {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const rendering = exports.find((film) => film.status === 'rendering');
  const busy = starting || rendering !== undefined;

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
    filmFile(imp, project.id, film)
      .then((blob) => {
        download(blob, film.fileName);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setSaving(null);
      });
  };
  const speed = (film: FilmExport): string =>
    film.renderSeconds > 0 && film.progressSeconds > 0
      ? ` · ${(film.progressSeconds / film.renderSeconds).toFixed(1)}× real time`
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
          <DownloadSimpleIcon aria-hidden="true" /> Export scene
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            start(undefined);
          }}
        >
          <FilmStripIcon aria-hidden="true" /> Export film
        </button>
        {rendering !== undefined && (
          <>
            <button
              className="button quiet"
              onClick={() => {
                act('movie.edit.export.cancel', { exportId: rendering.id });
              }}
            >
              <StopIcon aria-hidden="true" /> Cancel
            </button>
            <progress
              aria-label="Export progress"
              max={Math.max(1, rendering.durationSeconds)}
              value={rendering.progressSeconds}
            />
            <span className="muted mono" role="status">
              Rendering {rendering.label} · {clock(rendering.progressSeconds)} /{' '}
              {clock(rendering.durationSeconds)}
              {speed(rendering)}
              {rendering.by === 'you' ? '' : ` · by ${rendering.by}`}
            </span>
          </>
        )}
      </div>
      <p className="muted">
        Films are rendered to MP4 in the background, faster than real time. You can keep working or
        switch tabs while it runs, and the Film Editor can export too.
      </p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="film-exports" aria-label="Rendered films">
          {shown.map((film) => (
            <li key={film.id} className="film-export">
              <span className="film-export-name">{film.fileName}</span>
              <span className="muted mono">
                {film.status === 'ready'
                  ? `${clock(film.durationSeconds)} · ${String(film.width)}×${String(film.height)} ${String(film.fps)} fps · ${size(film.sizeBytes)}`
                  : film.status === 'cancelled'
                    ? 'Cancelled'
                    : `Failed: ${film.error}`}
                {film.by === 'you' ? '' : ` · by ${film.by}`}
              </span>
              {film.status === 'ready' && (film.notReady.length > 0 || film.unheard.length > 0) && (
                <span className="muted film-export-note">
                  {film.notReady.length > 0 &&
                    `${String(film.notReady.length)} item${film.notReady.length === 1 ? '' : 's'} not ready. `}
                  {film.unheard.length > 0 && `Silent: ${film.unheard.join(', ')}.`}
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
                    {saving === film.id ? 'Preparing…' : 'Download'}
                  </button>
                )}
                <button
                  className="button small icon danger-quiet"
                  aria-label={`Delete ${film.fileName}`}
                  title="Delete"
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
}: {
  project: Project;
  sceneId: string | undefined;
  sceneIds: readonly string[];
}): ReactElement {
  const imp = useImp();
  const format = recordingFormat();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = progress !== null;

  const start = (ids: readonly string[], label: string): void => {
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setDone(null);
    setProgress({ scene: 0, scenes: ids.length, seconds: 0, totalSeconds: 0 });
    recordScenes(imp, project.id, ids, setProgress, controller.signal)
      .then((recording) => {
        const name = `${project.name.replace(/[^\w.-]+/g, '-')}-${label}.${recording.extension}`;
        download(recording.blob, name);
        setDone(`Saved ${name} (${clock(recording.seconds)}).`);
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
          <DownloadSimpleIcon aria-hidden="true" /> Export scene
        </button>
        <button
          className="button"
          disabled={running || format === null || sceneIds.length === 0}
          onClick={() => {
            start(sceneIds, 'film');
          }}
        >
          <FilmStripIcon aria-hidden="true" /> Export film
        </button>
        {running && (
          <>
            <button
              className="button quiet"
              onClick={() => {
                abort.current?.abort();
              }}
            >
              <StopIcon aria-hidden="true" /> Cancel
            </button>
            <progress
              aria-label="Export progress"
              max={Math.max(1, progress.totalSeconds)}
              value={progress.seconds}
            />
            <span className="muted mono" role="status">
              Scene {String(progress.scene)} of {String(progress.scenes)} ·{' '}
              {clock(progress.seconds)} / {clock(progress.totalSeconds)}
            </span>
          </>
        )}
      </div>
      <p className="muted">
        {format === null
          ? 'This browser cannot record video. Try a current Chrome, Edge or Safari.'
          : `Films cannot be rendered in the background here, so the cut is played through once in real time and recorded as ${format.extension.toUpperCase()}. Keep this tab visible until it finishes.`}
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
