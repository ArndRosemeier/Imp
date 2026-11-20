import type { Project } from '@imp/core';
import { DownloadSimpleIcon, StopIcon } from '@phosphor-icons/react';
import { useRef, useState, type ReactElement } from 'react';
import { messageOf, useImp } from './context.js';
import { clock } from './cut-player.js';
import { download, recordingFormat, recordScenes, type Progress } from './export.js';

/** Buttons to save the cut of one scene, or of the whole film, as a video file. */
export function ExportBar({
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
          <DownloadSimpleIcon aria-hidden="true" /> Export film
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
          : `The cut is played through once in real time and recorded as ${format.extension.toUpperCase()}. Keep this tab visible until it finishes.`}
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
