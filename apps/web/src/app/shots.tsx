import type { Project } from '@imp/core';
import {
  Character,
  dialogueOver,
  IMAGE_MODEL_SETTING,
  Scene,
  Shot,
  shortSceneTitle,
  SPEECH_MODEL_SETTING,
  VIDEO_MODEL_SETTING,
} from '@imp/mode-movie';
import type { ScriptLineView } from '@imp/mode-movie';
import {
  ArrowCounterClockwiseIcon,
  FilmStripIcon,
  MicrophoneIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { useLibraryDrop } from './library/drag.js';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { WorkingOn } from './work.js';
import { RenderingBadge, usePendingClips } from './clips-pending.js';
import { ConfirmButton, EditableField } from './Field.js';
import { ShotPlace, useWorld } from './place.js';
import { moviePrefix, Problem, useAct, useBlobUrl, useModelSetting, type Act } from './movie.js';
import { ModelBar } from './model-bar.js';
import { CheckpointBar } from './checkpoints.js';
import { Storyboard } from './storyboard.js';
import { formatUsd, Price } from './spend.js';
import { useScriptLines } from './screenplay.js';
import { EmptyState } from './help/EmptyState.js';
import { currentLanguage, fixed, t, tn, tx } from '../i18n/i18n.js';
import { ImpSpinner } from './ImpMark.js';
import { Marked } from '../i18n/Marked.js';

const Scenes = z.object({
  scenes: z.array(Scene.pick({ id: true, position: true, heading: true, locationId: true })),
});
const Cast = z.object({
  characters: z.array(Character.pick({ id: true, name: true, voiceOnly: true })),
});
const Shots = z.object({ shots: z.array(Shot) });

function ClipPlayer({ shot }: { shot: Shot }): ReactElement {
  const clip = shot.clip;
  const problem = usePendingClips().problems.get(shot.id);
  const url = useBlobUrl(clip?.blobKey ?? undefined);
  if (clip === null) {
    return (
      <div className="clip clip-empty">
        <FilmStripIcon aria-hidden="true" />
        <span>{t('No clip yet')}</span>
      </div>
    );
  }
  if (clip.status === 'pending') {
    return (
      <div className="clip clip-empty clip-rendering" role="status" aria-busy="true">
        <ImpSpinner size={28} />
        <span>
          {t('Being made')}
          {clip.progress === null ? '' : `, ${String(Math.round(clip.progress))}%`}…
        </span>
        <span className="muted">
          {t('Started {time} with {model}. This takes a minute or more. You can leave this view.', {
            time: new Intl.DateTimeFormat(currentLanguage(), { timeStyle: 'short' }).format(
              new Date(clip.createdAt),
            ),
            model: clip.model,
          })}
        </span>
        {problem !== undefined && (
          <span className="muted">
            {t('The last check failed: {problem}. Imp keeps trying.', { problem })}
          </span>
        )}
      </div>
    );
  }
  if (clip.status === 'failed') {
    return (
      <div className="clip clip-empty">
        <span className="error">
          {t('No clip was made:')} {clip.error ?? t('the model gave no reason')}
        </span>
      </div>
    );
  }
  const overlaid = dialogueOver(clip) && shot.dialogue !== null;
  return (
    <figure className="clip">
      {url !== null &&
        (overlaid ? (
          <DubbedVideo
            src={url}
            silent={clip.silent}
            dialogueKey={shot.dialogue?.blobKey}
            label={t('Clip of shot {position}', { position: String(shot.position) })}
          />
        ) : (
          // The line spoken is shown in the field below; a generated clip has no caption track.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            controls
            src={url}
            aria-label={t('Clip of shot {position}', { position: String(shot.position) })}
          />
        ))}
      <figcaption className="muted">
        {clip.model === 'file' ? t('From a file') : clip.model}
        {clip.durationSeconds === null ? '' : ` · ${seconds(clip.durationSeconds)}`}
        {clip.costUsd === null ? '' : ` · ${formatUsd(clip.costUsd)}`}
        {clip.model === 'file'
          ? ''
          : clip.startFrameId !== null
            ? t(' · starts on the key frame')
            : clip.guides.length === 0
              ? t(' · made from the words alone, without pictures')
              : t(' · guided by {value}', { value: clip.guides.join(', ') })}
        {overlaid
          ? clip.silent
            ? t(' · silent, the recorded voice plays over it')
            : t(' · the recorded voice plays over its sound')
          : clip.silent
            ? t(' · silent, as asked')
            : ''}
      </figcaption>
    </figure>
  );
}

/** A clip length as people read it: "4 s", "4.5 s", never "4.041667 s". */
function seconds(value: number): string {
  return t('{value} s', { value: String(Math.round(value * 10) / 10) });
}

/** One earlier clip of a shot: a still that plays when tapped, and what it was made with. */
function TakeCard({
  take,
  number,
  shotPosition,
  disabled,
  onUse,
  onDelete,
}: {
  take: Shot['takes'][number];
  number: number;
  shotPosition: number;
  disabled: boolean;
  onUse: () => void;
  onDelete: () => void;
}): ReactElement {
  const url = useBlobUrl(take.blobKey ?? undefined);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const label = t('Take {number} of shot {shotPosition}', {
    number: String(number),
    shotPosition: String(shotPosition),
  });
  return (
    <li className="take">
      <button
        className="take-still"
        aria-label={playing ? t('Stop {label}', { label }) : t('Play {label}', { label })}
        aria-pressed={playing}
        onClick={() => {
          const element = video.current;
          if (element === null) return;
          if (element.paused) {
            element.currentTime = 0;
            void element.play();
          } else {
            element.pause();
          }
        }}
      >
        {url !== null && (
          // A muted preview of a take; its words are the shot's line, shown above.
          <video
            ref={video}
            src={`${url}#t=0.5`}
            muted
            playsInline
            preload="metadata"
            onPlay={() => {
              setPlaying(true);
            }}
            onPause={() => {
              setPlaying(false);
            }}
            onEnded={() => {
              setPlaying(false);
            }}
          />
        )}
        <span className="take-number">{number}</span>
      </button>
      <span className="muted small take-info" title={take.prompt}>
        {take.model === 'file' ? t('From a file') : take.model.split('/').at(-1)}
        {take.durationSeconds === null ? '' : ` · ${seconds(take.durationSeconds)}`}
        {take.silent ? ' · silent' : ''}
      </span>
      <div className="row take-actions">
        <button
          className="button small"
          disabled={disabled}
          title={t('Make this take the clip again; the clip now in use becomes a take.')}
          onClick={onUse}
        >
          <ArrowCounterClockwiseIcon aria-hidden="true" /> {t('Use')}
        </button>
        <ConfirmButton
          label={t('Delete')}
          question={t('Delete this take for good?')}
          onConfirm={onDelete}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      </div>
    </li>
  );
}

/**
 * The earlier clips of a shot. Each new clip keeps the one it replaces, so a
 * take that played better can be put back; the cut then plays it at once.
 */
function Takes({ shot, act }: { shot: Shot; act: Act }): ReactElement | null {
  if (shot.takes.length === 0) return null;
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const pending = shot.clip?.status === 'pending';
  return (
    <section
      className="stack takes"
      aria-label={t('Earlier takes of shot {position}', { position: String(shot.position) })}
    >
      <div className="row spread wrap">
        <h4>{t('Earlier takes')}</h4>
        <span className="muted small">
          {pending ? t('Wait for the new clip before swapping.') : t('Tap one to watch it.')}
        </span>
      </div>
      <ol className="take-list">
        {shot.takes.map((take, index) => (
          <TakeCard
            key={take.blobKey ?? index}
            take={take}
            number={index + 1}
            shotPosition={shot.position}
            disabled={pending}
            onUse={() => {
              void act('movie.shot.take.use', { ...at, blobKey: take.blobKey });
            }}
            onDelete={() => {
              void act('movie.shot.take.delete', { ...at, blobKey: take.blobKey });
            }}
          />
        ))}
      </ol>
    </section>
  );
}

function FrameImage({ blobKey, alt }: { blobKey: string; alt: string }): ReactElement | null {
  const url = useBlobUrl(blobKey);
  return url === null ? null : <img src={url} alt={alt} />;
}

/**
 * The key frame of a shot: a still of its first instant, painted from the
 * pictures of its place, people and objects. The clip starts exactly on it.
 */
function KeyFrames({
  shot,
  imageModel,
  act,
  end = false,
}: {
  shot: Shot;
  imageModel: string | null;
  act: Act;
  /** The frames the clip lands on, instead of the ones it starts on. */
  end?: boolean;
}): ReactElement {
  const directionId = useId();
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const frames = end ? shot.endFrames : shot.frames;
  const chosenId = end ? shot.endFrameId : shot.frameId;
  const chosen = frames.find((frame) => frame.id === chosenId);
  const which = end ? { end: true } : {};
  const paint = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    void act('movie.shot.frame.generate', {
      ...at,
      ...which,
      ...(direction.trim() === '' ? {} : { direction: direction.trim() }),
    }).finally(() => {
      setBusy(false);
    });
  };
  // A picture from the library becomes a key frame, the one the clip starts on.
  const frameBox = useRef<HTMLElement>(null);
  useLibraryDrop(frameBox, {
    label: end
      ? t('Shot {position}, end frame', { position: String(shot.position) })
      : t('Shot {position}, key frame', { position: String(shot.position) }),
    accepts: (asset) => asset.modality === 'image' && asset.blobKey !== null,
    onDrop: async (asset) => {
      await act('movie.shot.frame.fromFile', { ...at, ...which, blobKey: asset.blobKey });
    },
  });
  return (
    <section
      ref={frameBox}
      className="stack key-frames"
      aria-label={
        end
          ? t('End frame of shot {position}', { position: String(shot.position) })
          : t('Key frame of shot {position}', { position: String(shot.position) })
      }
    >
      <div className="row spread wrap">
        <h4>{end ? t('End frame') : t('Key frame')}</h4>
        <span className="muted small">
          {end
            ? chosen === undefined
              ? t('Optional: where the clip lands. Without one, the model decides.')
              : t('The clip ends on this frame, where the model takes one.')
            : chosen === undefined
              ? frames.length === 0
                ? t('The clip starts from words and pictures alone.')
                : t('None chosen: the clip starts from words and pictures.')
              : t('The clip starts exactly on this frame.')}
        </span>
      </div>
      {(chosen !== undefined || busy) && (
        <div className="plate" aria-busy={busy}>
          {chosen !== undefined && (
            <FrameImage
              blobKey={chosen.blobKey}
              alt={
                end
                  ? t('End frame of shot {position}', { position: String(shot.position) })
                  : t('Key frame of shot {position}', { position: String(shot.position) })
              }
            />
          )}
          {busy && (
            <span className="portrait-busy" role="status">
              {t('Painting…')}
            </span>
          )}
        </div>
      )}
      {chosen !== undefined && (
        <span className="muted small">
          {chosen.guides.length === 0
            ? t('Painted from the words alone.')
            : t('Painted from {value}.', { value: chosen.guides.join(', ') })}
        </span>
      )}
      {frames.length > 0 && (
        <div
          className="thumbs wide"
          role="group"
          aria-label={end ? t('End frames to choose from') : t('Key frames to choose from')}
        >
          {frames.map((frame, index) => (
            <button
              key={frame.id}
              className="thumb"
              aria-pressed={frame.id === chosenId}
              aria-label={
                end
                  ? t('End the clip on frame {value}', { value: String(index + 1) })
                  : t('Start the clip on frame {value}', { value: String(index + 1) })
              }
              title={frame.prompt}
              onClick={() => {
                void act('movie.shot.frame.select', {
                  ...at,
                  ...which,
                  frameId: frame.id === chosenId ? null : frame.id,
                });
              }}
            >
              <FrameImage blobKey={frame.blobKey} alt="" />
            </button>
          ))}
        </div>
      )}
      <form className="row portrait-make" onSubmit={paint}>
        <label className="sr-only" htmlFor={directionId}>
          {end ? t('Direction for the next end frame') : t('Direction for the next key frame')}
        </label>
        <input
          id={directionId}
          type="text"
          className="input"
          value={direction}
          placeholder={t('Direction, e.g. closer, Mara on the left')}
          onChange={(event) => {
            setDirection(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button"
          disabled={busy || imageModel === null || shot.description.trim() === ''}
          title={
            imageModel === null
              ? t('Choose an image model first.')
              : t('Painted by {imageModel}', { imageModel })
          }
        >
          <SparkleIcon aria-hidden="true" />{' '}
          {frames.length === 0 ? (end ? t('Paint end frame') : t('Paint frame')) : t('Another')}
          <Price command="movie.shot.frame.generate" input={at} />
        </button>
      </form>
      {chosen !== undefined && (
        <div className="row">
          <ConfirmButton
            label={t('Delete frame')}
            question={
              end ? t('Delete this end frame for good?') : t('Delete this key frame for good?')
            }
            onConfirm={() => {
              void act('movie.shot.frame.delete', { ...at, ...which, frameId: chosen.id });
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        </div>
      )}
    </section>
  );
}

/**
 * A clip with the dialogue laid over it: the two start, stop and seek
 * together. The sound is a second element kept in step, not mixed into the file.
 */
function DubbedVideo({
  src,
  silent,
  dialogueKey,
  label,
}: {
  src: string;
  /** Whether the clip has no sound of its own; otherwise it plays under the voice. */
  silent: boolean;
  dialogueKey: string | undefined;
  label: string;
}): ReactElement {
  const voice = useBlobUrl(dialogueKey);
  const audio = useRef<HTMLAudioElement>(null);
  const withAudio = (action: (element: HTMLAudioElement) => void): void => {
    if (audio.current !== null) action(audio.current);
  };
  return (
    <>
      {/* The line spoken is shown in the field below; a generated clip has no caption track. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        controls
        muted={silent}
        src={src}
        aria-label={label}
        onPlay={(event) => {
          withAudio((element) => {
            element.currentTime = event.currentTarget.currentTime;
            void element.play();
          });
        }}
        onPause={() => {
          withAudio((element) => {
            element.pause();
          });
        }}
        onSeeked={(event) => {
          withAudio((element) => {
            element.currentTime = event.currentTarget.currentTime;
          });
        }}
      />
      {voice !== null && (
        // The dialogue is the line shown in the field below, so it has no caption track.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio ref={audio} src={voice} aria-label={t('{label}, dialogue', { label })} />
      )}
    </>
  );
}

/** The scenes of the script as tabs, for the views that work scene by scene. */
export function SceneTabs({
  scenes,
  sceneId,
  onSelect,
}: {
  scenes: readonly { id: string; position: number; heading: string }[];
  sceneId: string | undefined;
  onSelect: (sceneId: string) => void;
}): ReactElement {
  const { clips } = usePendingClips();
  const rendering = (id: string): number => clips.filter((clip) => clip.sceneId === id).length;
  return (
    <div className="chips" role="tablist" aria-label={t('Scenes')}>
      {scenes.map((candidate) => (
        <button
          key={candidate.id}
          role="tab"
          className="chip"
          title={candidate.heading || undefined}
          aria-selected={candidate.id === sceneId}
          onClick={() => {
            onSelect(candidate.id);
          }}
        >
          <span>
            {candidate.position} · {shortSceneTitle(candidate.heading)}
          </span>
          {rendering(candidate.id) > 0 && (
            <RenderingBadge count={rendering(candidate.id)} compact />
          )}
          <WorkingOn kind="scene" id={candidate.id} compact />
        </button>
      ))}
    </div>
  );
}

/** The recorded voice of a shot's line, and the means to record it. */
function Dialogue({
  shot,
  voiceOnly,
  speechModel,
  act,
}: {
  shot: Shot;
  /** Whether the speaker is heard and not seen, so a recording can be laid over the clip. */
  voiceOnly: boolean;
  speechModel: string | null;
  act: Act;
}): ReactElement | null {
  const take = shot.dialogue;
  const url = useBlobUrl(take?.blobKey);
  const [busy, setBusy] = useState(false);
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const ready = shot.speakerId !== null && shot.line.trim() !== '';
  if (!ready && take === null) return null;
  // Someone on screen speaks in the clip itself, so the voice matches the lips.
  if (!voiceOnly && take === null) return null;
  const outdated = take !== null && take.line !== shot.line;
  return (
    <div className="stack dialogue">
      <div className="row wrap">
        <button
          className="button"
          disabled={busy || !ready || speechModel === null}
          title={
            speechModel === null
              ? t('Choose a voice model first.')
              : t('Records the line in the voice of the speaker. Costs a cent or less.')
          }
          onClick={() => {
            setBusy(true);
            void act('movie.shot.dialogue.generate', at).finally(() => {
              setBusy(false);
            });
          }}
        >
          <MicrophoneIcon aria-hidden="true" />{' '}
          {take === null ? t('Record dialogue') : t('Record dialogue again')}
          <Price command="movie.shot.dialogue.generate" input={at} />
        </button>
        {take !== null && (
          <ConfirmButton
            label={t('Delete dialogue')}
            question={t('Delete this recording for good?')}
            onConfirm={() => {
              void act('movie.shot.dialogue.delete', at);
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        )}
      </div>
      {take !== null && url !== null && (
        <figure className="voice">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            controls
            src={url}
            aria-label={t('Dialogue of shot {position}', { position: String(shot.position) })}
          />
          <figcaption className="muted">
            {take.durationSeconds === null
              ? ''
              : t('{value} s · ', { value: fixed(take.durationSeconds, 1) })}
            {take.model}
            {take.costUsd === null ? '' : ` · ${formatUsd(take.costUsd, 3)}`}
          </figcaption>
        </figure>
      )}
      {outdated && (
        <p className="muted" role="status">
          {t('The recording is of an earlier line or delivery. Record it again.')}
        </p>
      )}
      {take !== null && !voiceOnly && (
        <p className="muted" role="status">
          {t(
            'The speaker is on screen, so the clip speaks the line itself to match the lips. This recording is not laid over it; use it on the audio lane if you like.',
          )}
        </p>
      )}
      {take !== null && voiceOnly && shot.clip !== null && !dialogueOver(shot.clip) && (
        <p className="muted" role="status">
          {t('Generate the clip again to play this recording over it.')}
        </p>
      )}
    </div>
  );
}

function ShotCard({
  shot,
  cast,
  world,
  sceneLocationId,
  model,
  speechModel,
  imageModel,
  scriptLines,
  act,
}: {
  shot: Shot;
  cast: readonly { id: string; name: string; voiceOnly?: boolean }[];
  world: ReturnType<typeof useWorld>;
  sceneLocationId: string | null;
  model: string | null;
  speechModel: string | null;
  imageModel: string | null;
  /** The lines of the scene's script, to pick the shot's line from. */
  scriptLines: readonly ScriptLineView[];
  act: Act;
}): ReactElement {
  const speakerId = useId();
  const scriptId = useId();
  const fromScript = scriptLines.find((line) => line.shotIds.includes(shot.id));
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const [starting, setStarting] = useState(false);
  const [options, setOptions] = useState<ClipOptionValues>(DEFAULT_CLIP_OPTIONS);
  const generateInput = { ...at, ...clipOptionInput(options) };
  const pending = shot.clip?.status === 'pending';
  const change = (fields: Record<string, unknown>): Promise<unknown> =>
    act('movie.shot.update', { ...at, ...fields });

  // A video from the library becomes the clip of a shot; a clip it had is kept as a take.
  const card = useRef<HTMLElement>(null);
  useLibraryDrop(card, {
    label: t('Shot {position}, clip', { position: String(shot.position) }),
    accepts: (asset) =>
      asset.modality === 'video' && asset.blobKey !== null && shot.clip?.status !== 'pending',
    onDrop: async (asset) => {
      await act('movie.shot.clip.fromFile', {
        ...at,
        blobKey: asset.blobKey,
        ...(asset.durationSeconds === null ? {} : { durationSeconds: asset.durationSeconds }),
      });
    },
  });
  return (
    <article
      ref={card}
      data-shot-id={shot.id}
      className="card stack shot"
      aria-label={t('Shot {position}', { position: String(shot.position) })}
    >
      <div className="row spread">
        <h3>
          {t('Shot {position}', { position: shot.position })}
          {shot.pickup !== null && (
            <span
              className="pickup-badge"
              title={t('Asked for from the edit: {reason}', { reason: shot.pickup.reason })}
            >
              {t('Pickup')}
            </span>
          )}
          {pending && <RenderingBadge progress={shot.clip?.progress ?? null} />}
          <WorkingOn kind="shot" id={shot.id} />
        </h3>
        <ConfirmButton
          label={t('Delete shot')}
          question={t('Delete this shot and its clips for good?')}
          onConfirm={() => {
            void act('movie.shot.delete', at);
          }}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      </div>
      {shot.pickup !== null && shot.clip?.status !== 'ready' && (
        <p className="pickup-note">
          <Marked
            text={
              shot.pickup.requestedBy === 'person'
                ? t('**The edit needs this shot:** {reason} (asked by you, {seconds} s)', {
                    reason: shot.pickup.reason,
                    seconds: fixed(shot.pickup.seconds, 1),
                  })
                : t('**The edit needs this shot:** {reason} (asked by the {role}, {seconds} s)', {
                    reason: shot.pickup.reason,
                    role: tx(
                      shot.pickup.requestedBy
                        .split('-')
                        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(' '),
                    ),
                    seconds: fixed(shot.pickup.seconds, 1),
                  })
            }
          />
        </p>
      )}
      <ClipPlayer shot={shot} />
      <Takes shot={shot} act={act} />
      <EditableField
        label={t('What we see')}
        rows={3}
        value={shot.description}
        placeholder={t('Place, framing, camera movement, light. One shot of a few seconds.')}
        onCommit={(description) => change({ description })}
      />
      <EditableField
        label={t('Performance')}
        rows={3}
        value={shot.performance}
        placeholder={t(
          'Who moves how, how far, how fast, and how the others react. Models underplay bodies unless told.',
        )}
        onCommit={(performance) => change({ performance })}
      />
      {shot.position > 1 && <ShotJoinField shot={shot} change={change} />}
      <ShotLength shot={shot} change={change} />
      <ShotPlace
        shot={shot}
        sceneLocationId={sceneLocationId}
        locations={world.locations}
        objects={world.objects}
        change={change}
      />
      {cast.length > 0 && (
        <fieldset className="choices">
          <legend>{t('In the shot')}</legend>
          {cast.map((character) => (
            <label key={character.id} className="choice">
              <input
                type="checkbox"
                checked={shot.characterIds.includes(character.id)}
                onChange={() => {
                  void change({
                    characterIds: shot.characterIds.includes(character.id)
                      ? shot.characterIds.filter((id) => id !== character.id)
                      : [...shot.characterIds, character.id],
                  });
                }}
              />
              {character.name}
            </label>
          ))}
        </fieldset>
      )}
      {scriptLines.length > 0 && (
        <div className="field">
          <label htmlFor={scriptId}>{t('From the script')}</label>
          <select
            id={scriptId}
            className="select"
            value={fromScript === undefined ? '' : String(fromScript.index)}
            onChange={(event) => {
              const line = scriptLines.find(
                (candidate) => String(candidate.index) === event.target.value,
              );
              if (line === undefined) return;
              void change({
                line: line.words,
                ...(line.characterId === null ? {} : { speakerId: line.characterId }),
                ...(line.direction === '' ? {} : { delivery: line.direction }),
              });
            }}
          >
            <option value="">
              {shot.line.trim() === '' ? t('Choose a line…') : t('Not a line of the script')}
            </option>
            {scriptLines.map((line) => (
              <option key={line.index} value={String(line.index)}>
                {line.speaker}:{' '}
                {line.words.length > 70 ? `${line.words.slice(0, 70)}…` : line.words}
              </option>
            ))}
          </select>
        </div>
      )}
      <EditableField
        label={t('Line, as it is said')}
        script
        value={shot.line}
        placeholder={t('Written flat, it is spoken flat. Tomas! Get away from the rail!')}
        onCommit={(line) => change({ line })}
      />
      <div className="row wrap shot-speech">
        <div className="field">
          <label htmlFor={speakerId}>{t('Spoken by')}</label>
          <select
            id={speakerId}
            className="select"
            value={shot.speakerId ?? ''}
            onChange={(event) => {
              void change({ speakerId: event.target.value === '' ? null : event.target.value });
            }}
          >
            <option value="">{t('Nobody')}</option>
            {cast.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </div>
        <EditableField
          label={t('Delivery')}
          value={shot.delivery}
          placeholder={t('Screaming over the wind, voice cracking')}
          onCommit={(delivery) => change({ delivery })}
        />
      </div>
      <Dialogue
        shot={shot}
        voiceOnly={cast.some(
          (character) => character.id === shot.speakerId && character.voiceOnly === true,
        )}
        speechModel={speechModel}
        act={act}
      />
      {shot.join === 'continues' && shot.position > 1 ? (
        <p className="muted small">
          {t('The clip starts on the last frame of shot {position}, so it needs no key frame.', {
            position: String(shot.position - 1),
          })}
        </p>
      ) : (
        <KeyFrames shot={shot} imageModel={imageModel} act={act} />
      )}
      <KeyFrames shot={shot} imageModel={imageModel} act={act} end />
      <div className="row wrap">
        <button
          className="button"
          disabled={starting || pending || model === null || shot.description.trim() === ''}
          title={
            model === null
              ? t('Choose a video model first.')
              : t('Made with {model}. Video costs more than anything else here.', { model })
          }
          onClick={() => {
            setStarting(true);
            void act('movie.shot.clip.generate', generateInput).finally(() => {
              setStarting(false);
            });
          }}
        >
          <FilmStripIcon aria-hidden="true" />{' '}
          {shot.clip === null
            ? t('Generate clip')
            : shot.clip.status === 'failed'
              ? t('Try again')
              : t('Generate again')}
          <Price command="movie.shot.clip.generate" input={generateInput} />
        </button>
        {shot.clip !== null && !pending && (
          <ConfirmButton
            label={t('Delete clip')}
            question={
              shot.takes.length === 0
                ? t('Delete this clip for good?')
                : t('Delete this clip for good? Its earlier takes stay.')
            }
            onConfirm={() => {
              void act('movie.shot.clip.delete', at);
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        )}
      </div>
      <ClipOptions value={options} onChange={setOptions} />
    </article>
  );
}

export interface ClipOptionValues {
  /** Seconds wanted, or null for the length of the dialogue (or 4). */
  readonly durationSeconds: number | null;
  readonly resolution: string;
  readonly aspectRatio: string;
  /** Whether the clip has sound of its own. Sound is the default; silence is asked for. */
  readonly audio: boolean;
  readonly portraits: boolean;
  readonly startFrame: boolean;
  readonly endFrame: boolean;
}

export const DEFAULT_CLIP_OPTIONS: ClipOptionValues = {
  durationSeconds: null,
  resolution: '720p',
  aspectRatio: '16:9',
  audio: true,
  portraits: true,
  startFrame: true,
  endFrame: true,
};

const RESOLUTION_CHOICES = ['480p', '720p', '1080p'] as const;
const ASPECT_CHOICES = ['16:9', '9:16', '1:1', '4:3', '21:9'] as const;

/** Only what differs from the defaults goes to the command, so agents and people read the same call. */
export function clipOptionInput(options: ClipOptionValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (options.durationSeconds !== null) input['durationSeconds'] = options.durationSeconds;
  if (options.resolution !== DEFAULT_CLIP_OPTIONS.resolution)
    input['resolution'] = options.resolution;
  if (options.aspectRatio !== DEFAULT_CLIP_OPTIONS.aspectRatio)
    input['aspectRatio'] = options.aspectRatio;
  if (!options.audio) input['audio'] = false;
  if (!options.portraits) input['portraits'] = false;
  if (!options.startFrame) input['startFrame'] = false;
  if (!options.endFrame) input['endFrame'] = false;
  return input;
}

/** How the shot comes after the one before it, and why the cut is there. */
function ShotJoinField({
  shot,
  change,
}: {
  shot: Shot;
  change: (patch: Record<string, unknown>) => Promise<unknown>;
}): ReactElement {
  const joinId = useId();
  const choices = [
    { value: 'cut', label: t('A new angle or place') },
    { value: 'continues', label: t('Carries on the same take') },
    { value: 'action', label: t('Cut on action') },
  ] as const;
  const notes: Record<Shot['join'], string> = {
    cut: t('Its own key frame; nothing is shared with the shot before.'),
    continues: t(
      'Starts on the last frame of the shot before, so the action flows on. Made after that clip.',
    ),
    action: t(
      'The same instant from a new angle: its key frame is painted to match where the shot before ends.',
    ),
  };
  return (
    <div className="row wrap shot-join">
      <div className="field compact">
        <label htmlFor={joinId}>{t('Comes after the shot before as')}</label>
        <select
          id={joinId}
          className="select"
          title={notes[shot.join]}
          value={shot.join}
          onChange={(event) => {
            void change({ join: event.target.value });
          }}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      <EditableField
        label={t('Why cut here')}
        value={shot.cutReason}
        placeholder={t('On her look to the door; as he sits down; after the line')}
        onCommit={(cutReason) => change({ cutReason })}
      />
    </div>
  );
}

const LENGTH_CHOICES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30] as const;

/**
 * How long the shot holds in the cut, and why. The clip is made a little
 * longer, so the edit can trim it to its best moment.
 */
function ShotLength({
  shot,
  change,
}: {
  shot: Shot;
  change: (patch: Record<string, unknown>) => Promise<unknown>;
}): ReactElement {
  const lengthId = useId();
  const planned = shot.lengthSeconds;
  const choices: readonly number[] =
    planned === null || (LENGTH_CHOICES as readonly number[]).includes(planned)
      ? LENGTH_CHOICES
      : [...LENGTH_CHOICES, planned].sort((a, b) => a - b);
  return (
    <div className="row wrap shot-length">
      <div className="field compact">
        <label htmlFor={lengthId}>{t('Holds in the cut (s)')}</label>
        <select
          id={lengthId}
          className="select"
          title={t(
            'How long the shot plays in the film. The clip is made a little longer, so the edit can cut it at its best moment.',
          )}
          value={planned === null ? '' : String(planned)}
          onChange={(event) => {
            void change({
              lengthSeconds: event.target.value === '' ? null : Number(event.target.value),
            });
          }}
        >
          <option value="">{t('Not planned')}</option>
          {choices.map((seconds) => (
            <option key={seconds} value={String(seconds)}>
              {String(seconds)}
            </option>
          ))}
        </select>
      </div>
      <EditableField
        label={t('Why that long')}
        value={shot.lengthReason}
        placeholder={t('A quick glance; lets the silence land; the walk to the door')}
        onCommit={(lengthReason) => change({ lengthReason })}
      />
    </div>
  );
}

/** The choices an agent has when it makes a clip, folded away under the Generate button. */
function ClipOptions({
  value,
  onChange,
}: {
  value: ClipOptionValues;
  onChange: (next: ClipOptionValues) => void;
}): ReactElement {
  const lengthId = useId();
  const sizeId = useId();
  const aspectId = useId();
  const changed = Object.keys(clipOptionInput(value)).length;
  const set = (patch: Partial<ClipOptionValues>): void => {
    onChange({ ...value, ...patch });
  };
  return (
    <details className="options-fold">
      <summary>
        {t('Clip options')}
        {changed > 0 && (
          <span className="muted"> · {tn(changed, '{count} changed', '{count} changed')}</span>
        )}
        {!value.audio && <span className="tag neutral">{t('silent')}</span>}
      </summary>
      <div className="row wrap">
        <div className="field compact">
          <label htmlFor={lengthId}>{t('Length (s)')}</label>
          <select
            id={lengthId}
            className="input"
            value={value.durationSeconds === null ? '' : String(value.durationSeconds)}
            onChange={(event) => {
              set({
                durationSeconds: event.target.value === '' ? null : Number(event.target.value),
              });
            }}
          >
            <option value="">{t('Automatic')}</option>
            {[2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30].map((seconds) => (
              <option key={seconds} value={seconds}>
                {String(seconds)}
              </option>
            ))}
          </select>
        </div>
        <div className="field compact">
          <label htmlFor={sizeId}>{t('Size')}</label>
          <select
            id={sizeId}
            className="input"
            value={value.resolution}
            onChange={(event) => {
              set({ resolution: event.target.value });
            }}
          >
            {RESOLUTION_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
        <div className="field compact">
          <label htmlFor={aspectId}>{t('Aspect ratio')}</label>
          <select
            id={aspectId}
            className="input"
            value={value.aspectRatio}
            onChange={(event) => {
              set({ aspectRatio: event.target.value });
            }}
          >
            {ASPECT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="choices">
        <label className="choice">
          <input
            type="checkbox"
            checked={value.audio}
            onChange={(event) => {
              set({ audio: event.target.checked });
            }}
          />
          {t('With its own sound')}
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={value.portraits}
            onChange={(event) => {
              set({ portraits: event.target.checked });
            }}
          />
          {t('Send the portraits as guides')}
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={value.startFrame}
            onChange={(event) => {
              set({ startFrame: event.target.checked });
            }}
          />
          {t('Start on the key frame')}
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={value.endFrame}
            onChange={(event) => {
              set({ endFrame: event.target.checked });
            }}
          />
          {t('End on the end frame')}
        </label>
      </div>
      <p className="muted small">
        {t(
          'The model makes the nearest length and size it can. Leave the portraits out for models that refuse them.',
        )}
      </p>
    </details>
  );
}

export function ShotsView({ project }: { project: Project }): ReactElement {
  const outline = useLive([moviePrefix(project)], async (imp) => ({
    scenes: Scenes.parse(await runCommand(imp, 'movie.scene.list', { projectId: project.id }))
      .scenes,
    cast: Cast.parse(await runCommand(imp, 'movie.character.list', { projectId: project.id }))
      .characters,
  }));
  const { act, error, retry } = useAct(project);
  const world = useWorld(project);
  const video = useModelSetting(VIDEO_MODEL_SETTING, 'video');
  const speech = useModelSetting(SPEECH_MODEL_SETTING, 'speech');
  const images = useModelSetting(IMAGE_MODEL_SETTING, 'image');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scenes = outline.data?.scenes ?? [];
  const scene = scenes.find((candidate) => candidate.id === selectedId) ?? scenes[0];
  const sceneId = scene?.id;

  const listed = useLive([`${moviePrefix(project)}shots/${sceneId ?? ''}`], async (imp) =>
    sceneId === undefined
      ? { shots: [] }
      : Shots.parse(
          await runCommand(imp, 'movie.shot.list', {
            projectId: project.id,
            sceneId,
            full: true,
          }),
        ),
  );
  const shots = listed.data?.shots.filter((shot) => shot.sceneId === sceneId) ?? [];
  const script = useScriptLines(project, sceneId);

  // Clips being made in other scenes, so they are found without opening every scene.
  const elsewhere = usePendingClips().clips.filter((clip) => clip.sceneId !== sceneId);

  return (
    <>
      <div className="view-head">
        <h1>{t('Shots')}</h1>
        <span className="muted">
          {tn(shots.length, '{count} shot in this scene', '{count} shots in this scene')}
        </span>
      </div>
      <ModelBar
        act={act}
        models={[
          {
            id: 'video-model',
            label: t('Video'),
            empty: t('Choose a model to make clips'),
            setting: VIDEO_MODEL_SETTING,
            choice: video,
          },
          {
            id: 'shots-voice-model',
            label: t('Voice'),
            empty: t('Choose a model to record dialogue'),
            setting: SPEECH_MODEL_SETTING,
            choice: speech,
          },
          {
            id: 'shots-image-model',
            label: t('Image'),
            empty: t('Choose a model to paint key frames'),
            setting: IMAGE_MODEL_SETTING,
            choice: images,
          },
        ]}
        note={t(
          'Clips come with their own sound: the video model speaks the lines of the characters on screen, so the lips match. Only a voice that is never seen, such as a narrator, is recorded on its own.',
        )}
      />
      <Problem
        text={outline.error ?? listed.error ?? error ?? video.error ?? speech.error ?? images.error}
        retry={retry}
      />
      <SceneTabs scenes={scenes} sceneId={sceneId} onSelect={setSelectedId} />
      {sceneId !== undefined && shots.length > 0 && (
        <>
          <Storyboard shots={shots} cast={outline.data?.cast ?? []} />
          <CheckpointBar project={project} checkpointId="storyboard" itemId={sceneId} />
        </>
      )}
      {elsewhere.length > 0 && (
        <div className="row wrap rendering-elsewhere">
          <span className="muted">{t('Rendering in other scenes:')}</span>
          {elsewhere.map((clip) => (
            <button
              key={clip.shotId}
              type="button"
              className="chip"
              onClick={() => {
                setSelectedId(clip.sceneId);
              }}
            >
              <ImpSpinner size={12} />
              {t('Scene {scene} · shot {shot}', {
                scene: String(clip.scenePosition),
                shot: String(clip.shotPosition),
              })}
            </button>
          ))}
        </div>
      )}
      {sceneId === undefined ? (
        outline.data !== undefined && (
          <EmptyState
            icon={FilmStripIcon}
            title={t('Write a scene first')}
            quip={t('No scenes, no shots. Even mischief needs a plan.')}
            body={t('Shots belong to scenes, and there are no scenes yet. Write the script first.')}
            go={{ stage: 'script', label: t('Go to Script') }}
          />
        )
      ) : (
        <>
          {listed.data !== undefined && shots.length === 0 && (
            <EmptyState
              icon={FilmStripIcon}
              title={t('No shots in this scene')}
              quip={t('Nothing is rolling yet.')}
              body={t(
                'This scene has no shots yet. Add one, or have the scene broken into shots of a few seconds each.',
              )}
              ask={t('Break the scene I am looking at into shots of four to eight seconds each.')}
            />
          )}
          <div className="grid shots">
            {shots.map((shot) => (
              <ShotCard
                key={shot.id}
                shot={shot}
                cast={outline.data?.cast ?? []}
                world={world}
                sceneLocationId={scene?.locationId ?? null}
                model={video.model}
                speechModel={speech.model}
                imageModel={images.model}
                scriptLines={script.data?.lines ?? []}
                act={act}
              />
            ))}
          </div>
          <div className="row">
            <button
              className="button"
              onClick={() => {
                void act('movie.shot.create', { sceneId });
              }}
            >
              <PlusIcon aria-hidden="true" /> {t('Add shot')}
            </button>
          </div>
        </>
      )}
    </>
  );
}
