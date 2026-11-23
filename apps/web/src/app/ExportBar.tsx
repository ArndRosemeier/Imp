import type { Project } from '@imp/core';
import type { FilmExport } from '@imp/mode-movie';
import {
  BooksIcon,
  DownloadSimpleIcon,
  FilmStripIcon,
  StopIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { clock } from './cut-player.js';
import { recordingFormat, recordScenes, type Progress } from './export.js';
import { saveFileAs } from './save-file.js';
import { filmFacts, FilmList, filmsPrefix, saveFilm, showFilms, useMadeBy } from './films.js';
import { FfmpegOffer } from './FfmpegOffer.js';
import { FFMPEG_STATE_KEY } from '@imp/host';
import { fixed, t, tn } from '../i18n/i18n.js';

/** How many rendered films the list shows; older ones stay until deleted. */
const SHOWN = 5;

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
  const live = useLive([filmsPrefix(project.id), FFMPEG_STATE_KEY], async (imp) =>
    FilmList.parse(await runCommand(imp, 'movie.edit.export.list', { projectId: project.id })),
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
  const [options, setOptions] = useState<ExportOptionValues>(DEFAULT_EXPORT_OPTIONS);
  const madeBy = useMadeBy();
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
      ...exportOptionInput(options),
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
    saveFilm(imp, project.id, film)
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
              {rendering.by === 'you' ? '' : ` · ${t('by {name}', { name: madeBy(rendering.by) })}`}
            </span>
          </>
        )}
      </div>
      <ExportOptions value={options} onChange={setOptions} />
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
              <span className="muted mono">{filmFacts(film, madeBy)}</span>
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
                    {saving === film.id ? t('Preparing…') : t('Save as…')}
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
      {exports.length > 0 && (
        <button
          type="button"
          className="button quiet small"
          onClick={() => {
            showFilms();
          }}
        >
          <BooksIcon aria-hidden="true" /> {t('All films in the Library')}
        </button>
      )}
    </div>
  );
}

export interface ExportOptionValues {
  readonly resolution: 'source' | '720p' | '1080p' | '2160p';
  /** Frames per second, or null for the rate most clips have. */
  readonly fps: number | null;
  /** A short file name, or empty for "film" or the scene. */
  readonly label: string;
  /** Burn the subtitles into the picture. */
  readonly subtitles: boolean;
  /** How loud the sound is levelled: for the web, for broadcast, or left as mixed. */
  readonly loudness: 'online' | 'broadcast' | 'off';
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptionValues = {
  resolution: 'source',
  fps: null,
  label: '',
  subtitles: true,
  loudness: 'online',
};

const LOUDNESS = ['online', 'broadcast', 'off'] as const;

function loudnessLabel(loudness: (typeof LOUDNESS)[number]): string {
  if (loudness === 'online') return t('For the web (-16 LUFS)');
  if (loudness === 'broadcast') return t('For broadcast (-23 LUFS)');
  return t('As mixed');
}

const RESOLUTIONS = ['source', '720p', '1080p', '2160p'] as const;
const FRAME_RATES = [24, 25, 30, 50, 60] as const;

/** Only what differs from the defaults goes to movie.edit.export. */
export function exportOptionInput(options: ExportOptionValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (options.resolution !== 'source') input['resolution'] = options.resolution;
  if (options.fps !== null) input['fps'] = options.fps;
  const label = options.label.trim();
  if (label !== '') input['label'] = label.slice(0, 60);
  if (!options.subtitles) input['subtitles'] = false;
  if (options.loudness !== 'online') input['loudness'] = options.loudness;
  return input;
}

function resolutionLabel(resolution: (typeof RESOLUTIONS)[number]): string {
  if (resolution === 'source') return t('Like the clips');
  if (resolution === '2160p') return t('2160p (4K)');
  return resolution;
}

/** Size, frame rate, file name and subtitles of the next film, folded away under the buttons. */
function ExportOptions({
  value,
  onChange,
}: {
  value: ExportOptionValues;
  onChange: (next: ExportOptionValues) => void;
}): ReactElement {
  const sizeId = useId();
  const fpsId = useId();
  const nameId = useId();
  const loudnessId = useId();
  const changed = Object.keys(exportOptionInput(value)).length;
  const set = (patch: Partial<ExportOptionValues>): void => {
    onChange({ ...value, ...patch });
  };
  return (
    <details className="options-fold">
      <summary>
        {t('Export options')}
        {changed > 0 && (
          <span className="muted"> · {tn(changed, '{count} changed', '{count} changed')}</span>
        )}
      </summary>
      <div className="row wrap">
        <div className="field compact">
          <label htmlFor={sizeId}>{t('Size')}</label>
          <select
            id={sizeId}
            className="input"
            value={value.resolution}
            onChange={(event) => {
              const next = RESOLUTIONS.find((choice) => choice === event.target.value);
              if (next !== undefined) set({ resolution: next });
            }}
          >
            {RESOLUTIONS.map((choice) => (
              <option key={choice} value={choice}>
                {resolutionLabel(choice)}
              </option>
            ))}
          </select>
        </div>
        <div className="field compact">
          <label htmlFor={fpsId}>{t('Frames per second')}</label>
          <select
            id={fpsId}
            className="input"
            value={value.fps === null ? '' : String(value.fps)}
            onChange={(event) => {
              set({ fps: event.target.value === '' ? null : Number(event.target.value) });
            }}
          >
            <option value="">{t('Like the clips')}</option>
            {FRAME_RATES.map((fps) => (
              <option key={fps} value={fps}>
                {String(fps)}
              </option>
            ))}
          </select>
        </div>
        <div className="field compact wide">
          <label htmlFor={nameId}>{t('File name')}</label>
          <input
            id={nameId}
            className="input"
            value={value.label}
            maxLength={60}
            placeholder={t('rough-cut-2')}
            onChange={(event) => {
              set({ label: event.target.value });
            }}
          />
        </div>
        <div className="field compact">
          <label htmlFor={loudnessId}>{t('Loudness')}</label>
          <select
            id={loudnessId}
            className="input"
            value={value.loudness}
            onChange={(event) => {
              const next = LOUDNESS.find((choice) => choice === event.target.value);
              if (next !== undefined) set({ loudness: next });
            }}
          >
            {LOUDNESS.map((choice) => (
              <option key={choice} value={choice}>
                {loudnessLabel(choice)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="choice">
        <input
          type="checkbox"
          checked={value.subtitles}
          onChange={(event) => {
            set({ subtitles: event.target.checked });
          }}
        />
        {t('Burn the subtitles into the picture')}
      </label>
      <p className="muted small">
        {t(
          'Leave the subtitles out for a film that gets a subtitle file instead. Other texts are always in the picture.',
        )}
      </p>
    </details>
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
