import type { Shot } from '@imp/mode-movie';
import { ArrowRightIcon, ImageIcon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import { useBlobUrl } from './movie.js';
import { t } from '../i18n/i18n.js';

/** The picture a shot shows on the storyboard: its key frame, else its end frame. */
function frameOf(shot: Shot): string | undefined {
  return (
    shot.frames.find((frame) => frame.id === shot.frameId)?.blobKey ??
    shot.endFrames.find((frame) => frame.id === shot.endFrameId)?.blobKey
  );
}

function Panel({
  shot,
  speaker,
  onOpen,
}: {
  shot: Shot;
  speaker: string | undefined;
  onOpen: () => void;
}): ReactElement {
  const key = frameOf(shot);
  const url = useBlobUrl(key);
  const continues = shot.join === 'continues' && shot.position > 1;
  const seconds = shot.lengthSeconds;
  return (
    <li className="storyboard-panel" data-join={shot.join}>
      <button
        type="button"
        className="storyboard-frame"
        aria-label={t('Go to shot {position}', { position: String(shot.position) })}
        onClick={onOpen}
      >
        {url !== null ? (
          <img src={url} alt="" />
        ) : (
          <span className="storyboard-empty">
            {continues ? <ArrowRightIcon aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
            {continues ? t('Carries on') : t('No key frame')}
          </span>
        )}
        <span className="storyboard-number">{shot.position}</span>
      </button>
      <span className="storyboard-meta muted">
        {seconds === null ? '–' : t('{value} s', { value: String(seconds) })}
        {shot.join === 'action' ? ` · ${t('cut on action')}` : ''}
        {continues ? ` · ${t('carries on')}` : ''}
      </span>
      {shot.line.trim() !== '' && (
        <span className="storyboard-line">
          {speaker === undefined ? '' : `${speaker}: `}
          {shot.line}
        </span>
      )}
    </li>
  );
}

/**
 * The storyboard of a scene: every shot as its key frame, in order, with how
 * long it holds, how it joins the one before and its line, so that the scene
 * can be judged as a whole before its clips are paid for.
 */
export function Storyboard({
  shots,
  cast,
}: {
  shots: readonly Shot[];
  cast: readonly { id: string; name: string }[];
}): ReactElement | null {
  if (shots.length === 0) return null;
  const painted = shots.filter((shot) => frameOf(shot) !== undefined).length;
  const total = shots.reduce((sum, shot) => sum + (shot.lengthSeconds ?? 0), 0);
  return (
    <section className="storyboard" aria-label={t('Storyboard')}>
      <div className="row spread">
        <h2>{t('Storyboard')}</h2>
        <span className="muted">
          {t('{painted} of {count} shots have a key frame · {seconds} s planned', {
            painted: String(painted),
            count: String(shots.length),
            seconds: String(Math.round(total * 10) / 10),
          })}
        </span>
      </div>
      <ol className="storyboard-strip">
        {shots.map((shot) => (
          <Panel
            key={shot.id}
            shot={shot}
            speaker={cast.find((member) => member.id === shot.speakerId)?.name}
            onOpen={() => {
              document
                .querySelector(`[data-shot-id="${shot.id}"]`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          />
        ))}
      </ol>
    </section>
  );
}
