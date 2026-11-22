import type { Project } from '@imp/core';
import {
  Character,
  IMAGE_MODEL_SETTING,
  Scene,
  Shot,
  shortSceneTitle,
  SPEECH_MODEL_SETTING,
  VIDEO_MODEL_SETTING,
} from '@imp/mode-movie';
import {
  ArrowCounterClockwiseIcon,
  FilmStripIcon,
  MicrophoneIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { useLibraryDrop } from './library/drag.js';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { ConfirmButton, EditableField } from './Field.js';
import { ShotPlace, useWorld } from './place.js';
import { moviePrefix, Problem, useAct, useBlobUrl, useModelSetting, type Act } from './movie.js';
import { ModelBar } from './model-bar.js';

const Scenes = z.object({
  scenes: z.array(Scene.pick({ id: true, position: true, heading: true, locationId: true })),
});
const Cast = z.object({ characters: z.array(Character.pick({ id: true, name: true })) });
const Shots = z.object({ shots: z.array(Shot) });

/** How often a clip that is being made is looked at again. */
const CHECK_EVERY_MS = 10_000;

function ClipPlayer({ shot }: { shot: Shot }): ReactElement {
  const clip = shot.clip;
  const url = useBlobUrl(clip?.blobKey ?? undefined);
  if (clip === null) {
    return (
      <div className="clip clip-empty">
        <FilmStripIcon aria-hidden="true" />
        <span>No clip yet</span>
      </div>
    );
  }
  if (clip.status === 'pending') {
    return (
      <div className="clip clip-empty" role="status" aria-busy="true">
        <span>
          Being made{clip.progress === null ? '' : `, ${String(Math.round(clip.progress))}%`}…
        </span>
        <span className="muted">This takes a minute or more. You can leave this view.</span>
      </div>
    );
  }
  if (clip.status === 'failed') {
    return (
      <div className="clip clip-empty">
        <span className="error">No clip was made: {clip.error ?? 'the model gave no reason'}</span>
      </div>
    );
  }
  const overlaid = clip.silent && shot.dialogue !== null;
  return (
    <figure className="clip">
      {url !== null &&
        (overlaid ? (
          <DubbedVideo
            src={url}
            dialogueKey={shot.dialogue?.blobKey}
            label={`Clip of shot ${String(shot.position)}`}
          />
        ) : (
          // The line spoken is shown in the field below; a generated clip has no caption track.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video controls src={url} aria-label={`Clip of shot ${String(shot.position)}`} />
        ))}
      <figcaption className="muted">
        {clip.model}
        {clip.durationSeconds === null ? '' : ` · ${String(clip.durationSeconds)} s`}
        {clip.costUsd === null ? '' : ` · $${clip.costUsd.toFixed(2)}`}
        {clip.startFrameId !== null
          ? ' · starts on the key frame'
          : clip.guides.length === 0
            ? ' · made from the words alone, without pictures'
            : ` · guided by ${clip.guides.join(', ')}`}
        {overlaid ? ' · silent, the recorded dialogue plays over it' : ''}
      </figcaption>
    </figure>
  );
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
  const label = `Take ${String(number)} of shot ${String(shotPosition)}`;
  return (
    <li className="take">
      <button
        className="take-still"
        aria-label={playing ? `Stop ${label}` : `Play ${label}`}
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
        {take.model === 'file' ? 'From a file' : take.model.split('/').at(-1)}
        {take.durationSeconds === null ? '' : ` · ${String(take.durationSeconds)} s`}
      </span>
      <div className="row take-actions">
        <button
          className="button small"
          disabled={disabled}
          title="Make this take the clip again; the clip now in use becomes a take."
          onClick={onUse}
        >
          <ArrowCounterClockwiseIcon aria-hidden="true" /> Use
        </button>
        <ConfirmButton label="Delete" question="Delete this take for good?" onConfirm={onDelete}>
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
    <section className="stack takes" aria-label={`Earlier takes of shot ${String(shot.position)}`}>
      <div className="row spread wrap">
        <h4>Earlier takes</h4>
        <span className="muted small">
          {pending ? 'Wait for the new clip before swapping.' : 'Tap one to watch it.'}
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
}: {
  shot: Shot;
  imageModel: string | null;
  act: Act;
}): ReactElement {
  const directionId = useId();
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const chosen = shot.frames.find((frame) => frame.id === shot.frameId);
  const paint = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    void act('movie.shot.frame.generate', {
      ...at,
      ...(direction.trim() === '' ? {} : { direction: direction.trim() }),
    }).finally(() => {
      setBusy(false);
    });
  };
  // A picture from the library becomes a key frame, the one the clip starts on.
  const frameBox = useRef<HTMLElement>(null);
  useLibraryDrop(frameBox, {
    label: `Shot ${String(shot.position)}, key frame`,
    accepts: (asset) => asset.modality === 'image' && asset.blobKey !== null,
    onDrop: async (asset) => {
      await act('movie.shot.frame.fromFile', { ...at, blobKey: asset.blobKey });
    },
  });
  return (
    <section
      ref={frameBox}
      className="stack key-frames"
      aria-label={`Key frame of shot ${String(shot.position)}`}
    >
      <div className="row spread wrap">
        <h4>Key frame</h4>
        <span className="muted small">
          {chosen === undefined
            ? shot.frames.length === 0
              ? 'The clip starts from words and pictures alone.'
              : 'None chosen: the clip starts from words and pictures.'
            : 'The clip starts exactly on this frame.'}
        </span>
      </div>
      {(chosen !== undefined || busy) && (
        <div className="plate" aria-busy={busy}>
          {chosen !== undefined && (
            <FrameImage
              blobKey={chosen.blobKey}
              alt={`Key frame of shot ${String(shot.position)}`}
            />
          )}
          {busy && (
            <span className="portrait-busy" role="status">
              Painting…
            </span>
          )}
        </div>
      )}
      {chosen !== undefined && (
        <span className="muted small">
          {chosen.guides.length === 0
            ? 'Painted from the words alone.'
            : `Painted from ${chosen.guides.join(', ')}.`}
        </span>
      )}
      {shot.frames.length > 0 && (
        <div className="thumbs wide" role="group" aria-label="Key frames to choose from">
          {shot.frames.map((frame, index) => (
            <button
              key={frame.id}
              className="thumb"
              aria-pressed={frame.id === shot.frameId}
              aria-label={`Start the clip on frame ${String(index + 1)}`}
              title={frame.prompt}
              onClick={() => {
                void act('movie.shot.frame.select', {
                  ...at,
                  frameId: frame.id === shot.frameId ? null : frame.id,
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
          Direction for the next key frame
        </label>
        <input
          id={directionId}
          type="text"
          className="input"
          value={direction}
          placeholder="Direction, e.g. closer, Mara on the left"
          onChange={(event) => {
            setDirection(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button"
          disabled={busy || imageModel === null || shot.description.trim() === ''}
          title={imageModel === null ? 'Choose an image model first.' : `Painted by ${imageModel}`}
        >
          <SparkleIcon aria-hidden="true" /> {shot.frames.length === 0 ? 'Paint frame' : 'Another'}
        </button>
      </form>
      {chosen !== undefined && (
        <div className="row">
          <ConfirmButton
            label="Delete frame"
            question="Delete this key frame for good?"
            onConfirm={() => {
              void act('movie.shot.frame.delete', { ...at, frameId: chosen.id });
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
 * A silent clip with the dialogue laid over it: the two start, stop and seek
 * together. The sound is a second element kept in step, not mixed into the file.
 */
function DubbedVideo({
  src,
  dialogueKey,
  label,
}: {
  src: string;
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
      <video
        controls
        muted
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
        <audio ref={audio} src={voice} aria-label={`${label}, dialogue`} />
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
  return (
    <div className="chips" role="tablist" aria-label="Scenes">
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
        </button>
      ))}
    </div>
  );
}

/** The recorded voice of a shot's line, and the means to record it. */
function Dialogue({
  shot,
  speechModel,
  act,
}: {
  shot: Shot;
  speechModel: string | null;
  act: Act;
}): ReactElement | null {
  const take = shot.dialogue;
  const url = useBlobUrl(take?.blobKey);
  const [busy, setBusy] = useState(false);
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const ready = shot.speakerId !== null && shot.line.trim() !== '';
  if (!ready && take === null) return null;
  const outdated = take !== null && take.line !== shot.line;
  return (
    <div className="stack dialogue">
      <div className="row wrap">
        <button
          className="button"
          disabled={busy || !ready || speechModel === null}
          title={
            speechModel === null
              ? 'Choose a voice model first.'
              : 'Records the line in the voice of the speaker. Costs a cent or less.'
          }
          onClick={() => {
            setBusy(true);
            void act('movie.shot.dialogue.generate', at).finally(() => {
              setBusy(false);
            });
          }}
        >
          <MicrophoneIcon aria-hidden="true" />{' '}
          {take === null ? 'Record dialogue' : 'Record dialogue again'}
        </button>
        {take !== null && (
          <ConfirmButton
            label="Delete dialogue"
            question="Delete this recording for good?"
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
          <audio controls src={url} aria-label={`Dialogue of shot ${String(shot.position)}`} />
          <figcaption className="muted">
            {take.durationSeconds === null ? '' : `${take.durationSeconds.toFixed(1)} s · `}
            {take.model}
            {take.costUsd === null ? '' : ` · $${take.costUsd.toFixed(3)}`}
          </figcaption>
        </figure>
      )}
      {outdated && (
        <p className="muted" role="status">
          The recording is of an earlier line or delivery. Record it again.
        </p>
      )}
      {take !== null && shot.clip !== null && !shot.clip.silent && (
        <p className="muted" role="status">
          This clip has a voice of its own. Generate it again to play the recording over a silent
          one.
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
  act,
}: {
  shot: Shot;
  cast: readonly { id: string; name: string }[];
  world: ReturnType<typeof useWorld>;
  sceneLocationId: string | null;
  model: string | null;
  speechModel: string | null;
  imageModel: string | null;
  act: Act;
}): ReactElement {
  const speakerId = useId();
  const at = { sceneId: shot.sceneId, shotId: shot.id };
  const [starting, setStarting] = useState(false);
  const pending = shot.clip?.status === 'pending';
  const change = (fields: Record<string, unknown>): Promise<unknown> =>
    act('movie.shot.update', { ...at, ...fields });

  // A video from the library becomes the clip of a shot; a clip it had is kept as a take.
  const card = useRef<HTMLElement>(null);
  useLibraryDrop(card, {
    label: `Shot ${String(shot.position)}, clip`,
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
    <article ref={card} className="card stack shot" aria-label={`Shot ${String(shot.position)}`}>
      <div className="row spread">
        <h3>
          Shot {shot.position}
          {shot.pickup !== null && (
            <span className="pickup-badge" title={`Asked for from the edit: ${shot.pickup.reason}`}>
              Pickup
            </span>
          )}
        </h3>
        <ConfirmButton
          label="Delete shot"
          question="Delete this shot and its clips for good?"
          onConfirm={() => {
            void act('movie.shot.delete', at);
          }}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      </div>
      {shot.pickup !== null && shot.clip?.status !== 'ready' && (
        <p className="pickup-note">
          <strong>The edit needs this shot:</strong> {shot.pickup.reason}{' '}
          <span className="muted">
            (
            {shot.pickup.requestedBy === 'person'
              ? 'asked by you'
              : `asked by the ${shot.pickup.requestedBy.replace(/-/g, ' ')}`}
            , {shot.pickup.seconds.toFixed(1)} s)
          </span>
        </p>
      )}
      <ClipPlayer shot={shot} />
      <Takes shot={shot} act={act} />
      <EditableField
        label="What we see"
        rows={3}
        value={shot.description}
        placeholder="Place, framing, camera movement, light. One shot of a few seconds."
        onCommit={(description) => change({ description })}
      />
      <EditableField
        label="Performance"
        rows={3}
        value={shot.performance}
        placeholder="Who moves how, how far, how fast, and how the others react. Models underplay bodies unless told."
        onCommit={(performance) => change({ performance })}
      />
      <ShotPlace
        shot={shot}
        sceneLocationId={sceneLocationId}
        locations={world.locations}
        objects={world.objects}
        change={change}
      />
      {cast.length > 0 && (
        <fieldset className="choices">
          <legend>In the shot</legend>
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
      <EditableField
        label="Line, as it is said"
        script
        value={shot.line}
        placeholder="Written flat, it is spoken flat. Tomas! Get away from the rail!"
        onCommit={(line) => change({ line })}
      />
      <div className="row wrap shot-speech">
        <div className="field">
          <label htmlFor={speakerId}>Spoken by</label>
          <select
            id={speakerId}
            className="select"
            value={shot.speakerId ?? ''}
            onChange={(event) => {
              void change({ speakerId: event.target.value === '' ? null : event.target.value });
            }}
          >
            <option value="">Nobody</option>
            {cast.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </div>
        <EditableField
          label="Delivery"
          value={shot.delivery}
          placeholder="Screaming over the wind, voice cracking"
          onCommit={(delivery) => change({ delivery })}
        />
      </div>
      <Dialogue shot={shot} speechModel={speechModel} act={act} />
      <KeyFrames shot={shot} imageModel={imageModel} act={act} />
      <div className="row wrap">
        <button
          className="button"
          disabled={starting || pending || model === null || shot.description.trim() === ''}
          title={
            model === null
              ? 'Choose a video model first.'
              : `Made with ${model}. Video costs more than anything else here.`
          }
          onClick={() => {
            setStarting(true);
            void act('movie.shot.clip.generate', at).finally(() => {
              setStarting(false);
            });
          }}
        >
          <FilmStripIcon aria-hidden="true" />{' '}
          {shot.clip === null ? 'Generate clip' : 'Generate again'}
        </button>
        {shot.clip !== null && !pending && (
          <ConfirmButton
            label="Delete clip"
            question={
              shot.takes.length === 0
                ? 'Delete this clip for good?'
                : 'Delete this clip for good? Its earlier takes stay.'
            }
            onConfirm={() => {
              void act('movie.shot.clip.delete', at);
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        )}
      </div>
    </article>
  );
}

export function ShotsView({ project }: { project: Project }): ReactElement {
  const outline = useLive([moviePrefix(project)], async (imp) => ({
    scenes: Scenes.parse(await runCommand(imp, 'movie.scene.list', { projectId: project.id }))
      .scenes,
    cast: Cast.parse(await runCommand(imp, 'movie.character.list', { projectId: project.id }))
      .characters,
  }));
  const { act, error } = useAct(project);
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
          await runCommand(imp, 'movie.shot.list', { projectId: project.id, sceneId, full: true }),
        ),
  );
  const shots = listed.data?.shots.filter((shot) => shot.sceneId === sceneId) ?? [];

  // Clips that are being made are looked at again until they are done, also after a reload.
  const waiting = shots
    .filter((shot) => shot.clip?.status === 'pending')
    .map((shot) => shot.id)
    .join(',');
  useEffect(() => {
    if (waiting === '' || sceneId === undefined) return undefined;
    const timer = setInterval(() => {
      for (const shotId of waiting.split(',')) {
        void act('movie.shot.clip.check', { sceneId, shotId });
      }
    }, CHECK_EVERY_MS);
    return () => {
      clearInterval(timer);
    };
    // `act` is new on every render and does the same each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, sceneId]);

  return (
    <>
      <div className="view-head">
        <h1>Shots</h1>
        <span className="muted">
          {shots.length === 1 ? '1 shot' : `${String(shots.length)} shots`} in this scene
        </span>
      </div>
      <ModelBar
        act={act}
        models={[
          {
            id: 'video-model',
            label: 'Video',
            empty: 'Choose a model to make clips',
            setting: VIDEO_MODEL_SETTING,
            choice: video,
          },
          {
            id: 'shots-voice-model',
            label: 'Voice',
            empty: 'Choose a model to record dialogue',
            setting: SPEECH_MODEL_SETTING,
            choice: speech,
          },
          {
            id: 'shots-image-model',
            label: 'Image',
            empty: 'Choose a model to paint key frames',
            setting: IMAGE_MODEL_SETTING,
            choice: images,
          },
        ]}
        note="Video models invent a voice for any line. Dialogue is therefore recorded in the voice of the character and played over a silent clip; it is not lip-synced."
      />
      <Problem
        text={outline.error ?? listed.error ?? error ?? video.error ?? speech.error ?? images.error}
      />
      <SceneTabs scenes={scenes} sceneId={sceneId} onSelect={setSelectedId} />
      {sceneId === undefined ? (
        outline.data !== undefined && (
          <p className="muted">
            Shots belong to scenes, and there are no scenes yet. Write the script first.
          </p>
        )
      ) : (
        <>
          {listed.data !== undefined && shots.length === 0 && (
            <p className="muted">
              This scene has no shots yet. Add one, or ask the Clip Designer to break the scene into
              shots.
            </p>
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
              <PlusIcon aria-hidden="true" /> Add shot
            </button>
          </div>
        </>
      )}
    </>
  );
}
