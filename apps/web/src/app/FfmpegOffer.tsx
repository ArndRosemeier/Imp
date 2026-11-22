import { FFMPEG_STATE_KEY, FfmpegStatus } from '@imp/host';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { servedByLocalServer } from '../host/served.js';

const DISMISSED = 'imp.ffmpeg-offer.dismissed';

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1024 ** 2))} MB`;
}

/** ffmpeg on the local server as it is now; undefined in the browser or while loading. */
export function useFfmpeg(): FfmpegStatus | undefined {
  const served = servedByLocalServer();
  const live = useLive([FFMPEG_STATE_KEY], async (imp) =>
    served ? FfmpegStatus.parse(await runCommand(imp, 'system.ffmpeg.status', {})) : null,
  );
  return live.data ?? undefined;
}

/**
 * The local server without ffmpeg offers to fetch it: films then render in
 * the background, faster than real time, clip sound can be heard and agents
 * see stills of the cut. Until then films are recorded in the browser.
 * `compact` is the export bar's version, which can be put away for good.
 */
export function FfmpegOffer({ compact = false }: { compact?: boolean }): ReactElement | null {
  const imp = useImp();
  const status = useFfmpeg();
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === 'true';
    } catch {
      return false;
    }
  });
  if (status === undefined) return null;
  if (status.available) {
    return compact ? null : (
      <p className="muted">
        {status.source === 'system'
          ? 'ffmpeg is installed on this computer, so films render in the background and clip sound can be heard.'
          : 'Imp downloaded ffmpeg into its data folder, so films render in the background and clip sound can be heard.'}
      </p>
    );
  }
  if (compact && dismissed) return null;
  const downloading = status.downloading ?? (asked ? { receivedBytes: 0, totalBytes: 1 } : null);
  const install = (): void => {
    setAsked(true);
    setError(null);
    runCommand(imp, 'system.ffmpeg.install', {})
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setAsked(false);
      });
  };
  return (
    <div className={compact ? 'callout stack' : 'stack'} role="group" aria-label="ffmpeg">
      <p className={compact ? undefined : 'muted'}>
        {status.canDownload
          ? `Export films faster: Imp can download ffmpeg${status.downloadBytes === null ? '' : ` (${megabytes(status.downloadBytes)})`}, free software that renders films in the background and lets you hear the sound inside video clips. Without it, films are recorded in the browser in real time.`
          : 'Install ffmpeg from ffmpeg.org and start Imp again to render films in the background and hear the sound inside video clips. Without it, films are recorded in the browser in real time.'}
      </p>
      {status.canDownload && (
        <div className="row wrap">
          {downloading === null ? (
            <button type="button" className="button" onClick={install}>
              <DownloadSimpleIcon aria-hidden="true" /> Download ffmpeg
            </button>
          ) : (
            <>
              <progress
                aria-label="ffmpeg download"
                max={Math.max(1, downloading.totalBytes)}
                value={downloading.receivedBytes}
              />
              <span className="muted mono" role="status">
                Downloading ffmpeg
                {downloading.receivedBytes > 0
                  ? `, ${megabytes(downloading.receivedBytes)} of ${megabytes(downloading.totalBytes)}`
                  : ''}
              </span>
            </>
          )}
          {compact && downloading === null && (
            <button
              type="button"
              className="button quiet"
              onClick={() => {
                setDismissed(true);
                try {
                  localStorage.setItem(DISMISSED, 'true');
                } catch {
                  // Without storage it comes back next time, which is harmless.
                }
              }}
            >
              Not now
            </button>
          )}
        </div>
      )}
      {(error ?? status.error) !== null && (
        <p role="alert" className="error">
          {error ?? status.error}
        </p>
      )}
    </div>
  );
}
