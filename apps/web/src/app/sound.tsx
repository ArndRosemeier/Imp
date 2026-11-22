import type { Project } from '@imp/core';
import { EFFECT_MODEL_SETTING, MUSIC_MODEL_SETTING, Scene, Sound } from '@imp/mode-movie';
import { MusicNotesIcon, PlusIcon, TrashIcon, WaveformIcon } from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { ConfirmButton, EditableField } from './Field.js';
import { moviePrefix, Problem, useAct, useBlobUrl, useModelSetting, type Act } from './movie.js';
import { ModelBar } from './model-bar.js';
import { SceneTabs } from './shots.js';
import { Price } from './spend.js';
import { EmptyState } from './help/EmptyState.js';

const Scenes = z.object({
  scenes: z.array(Scene.pick({ id: true, position: true, heading: true })),
});
const Sounds = z.object({ sounds: z.array(Sound) });

const KIND = {
  effect: {
    label: 'Sound effect',
    icon: WaveformIcon,
    placeholder:
      'The source, its character, how it starts and ends. A heavy wooden door slamming shut in a stone hall, long echo.',
  },
  music: {
    label: 'Music',
    icon: MusicNotesIcon,
    placeholder:
      'Instruments, tempo, mood and how it develops. Low strings, slow, uneasy, swelling towards the end.',
  },
} as const;

function SoundCard({
  sound,
  model,
  act,
}: {
  sound: Sound;
  model: string | null;
  act: Act;
}): ReactElement {
  const at = { sceneId: sound.sceneId, soundId: sound.id };
  const [making, setMaking] = useState(false);
  const url = useBlobUrl(sound.take?.blobKey);
  const kind = KIND[sound.kind];
  const title = sound.name === '' ? kind.label : sound.name;

  return (
    <article className="card stack" aria-label={title}>
      <div className="row spread">
        <span className="sound-kind">
          <kind.icon aria-hidden="true" size={16} /> {kind.label}
        </span>
        <ConfirmButton
          label="Delete sound"
          question="Delete this sound for good?"
          onConfirm={() => {
            void act('movie.sound.delete', at);
          }}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      </div>
      <EditableField
        label="Name"
        value={sound.name}
        placeholder={sound.kind === 'music' ? 'Storm theme' : 'Wind on the gallery'}
        onCommit={(name) => act('movie.sound.update', { ...at, name })}
      />
      <EditableField
        label="What is heard"
        rows={3}
        value={sound.description}
        placeholder={kind.placeholder}
        onCommit={(description) => act('movie.sound.update', { ...at, description })}
      />
      {making ? (
        <div className="sound-empty" role="status" aria-busy="true">
          Being made…
        </div>
      ) : sound.take === null ? (
        <div className="sound-empty">Not made yet</div>
      ) : (
        <figure className="sound-take">
          {url !== null && (
            // There are no words in it to caption.
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio controls src={url} aria-label={`Recording of ${title}`} />
          )}
          <figcaption className="muted">
            {sound.take.model}
            {sound.take.costUsd === null ? '' : ` · $${sound.take.costUsd.toFixed(2)}`}
          </figcaption>
        </figure>
      )}
      <div className="row">
        <button
          className="button"
          disabled={making || model === null || sound.description.trim() === ''}
          title={
            model === null
              ? `Choose a model for ${sound.kind === 'music' ? 'music' : 'sound effects'} first.`
              : `Made with ${model}.`
          }
          onClick={() => {
            setMaking(true);
            void act('movie.sound.generate', at).finally(() => {
              setMaking(false);
            });
          }}
        >
          <kind.icon aria-hidden="true" /> {sound.take === null ? 'Generate' : 'Generate again'}
          <Price command="movie.sound.generate" input={at} />
        </button>
      </div>
    </article>
  );
}

export function SoundView({ project }: { project: Project }): ReactElement {
  const outline = useLive([`${moviePrefix(project)}scenes/`], async (imp) =>
    Scenes.parse(await runCommand(imp, 'movie.scene.list', { projectId: project.id })),
  );
  const { act, error } = useAct(project);
  const effects = useModelSetting(EFFECT_MODEL_SETTING, 'speech');
  const music = useModelSetting(MUSIC_MODEL_SETTING, 'audio');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scenes = outline.data?.scenes ?? [];
  const sceneId = (scenes.find((candidate) => candidate.id === selectedId) ?? scenes[0])?.id;

  const listed = useLive([`${moviePrefix(project)}sounds/${sceneId ?? ''}`], async (imp) =>
    sceneId === undefined
      ? { sounds: [] }
      : Sounds.parse(await runCommand(imp, 'movie.sound.list', { projectId: project.id, sceneId })),
  );
  const sounds = listed.data?.sounds.filter((sound) => sound.sceneId === sceneId) ?? [];
  const add = (kind: Sound['kind']): void => {
    void act('movie.sound.create', { sceneId, kind });
  };

  return (
    <>
      <div className="view-head">
        <h1>Sound</h1>
        <span className="muted">
          {sounds.length === 1 ? '1 sound' : `${String(sounds.length)} sounds`} in this scene
        </span>
      </div>
      <ModelBar
        act={act}
        models={[
          {
            id: 'effects-model',
            label: 'Sound effects',
            empty: 'Choose a model to make effects',
            setting: EFFECT_MODEL_SETTING,
            choice: effects,
          },
          {
            id: 'music-model',
            label: 'Music',
            empty: 'Choose a model to make music',
            setting: MUSIC_MODEL_SETTING,
            choice: music,
          },
        ]}
        note="Effects are made by speech models, and not every one of them can: a model that cannot reads the description aloud instead."
      />
      <Problem text={outline.error ?? listed.error ?? error ?? effects.error ?? music.error} />
      <SceneTabs scenes={scenes} sceneId={sceneId} onSelect={setSelectedId} />
      {sceneId === undefined ? (
        outline.data !== undefined && (
          <EmptyState
            icon={WaveformIcon}
            title="Write a scene first"
            quip="Even an imp can’t score a scene nobody has written."
            body="Sounds belong to scenes, and there are no scenes yet. Write the script first."
            go={{ stage: 'script', label: 'Go to Script' }}
          />
        )
      ) : (
        <>
          {listed.data !== undefined && sounds.length === 0 && (
            <EmptyState
              icon={WaveformIcon}
              title="Nothing to hear yet"
              quip="Suspiciously quiet in here."
              body="This scene is silent so far. Add an effect or music, or have the sound of the scene worked out for you."
              ask="Work out what the scene I am looking at sounds like: ambience, effects and music. Tell me the price before making them."
            />
          )}
          <div className="grid sounds">
            {sounds.map((sound) => (
              <SoundCard
                key={sound.id}
                sound={sound}
                model={(sound.kind === 'music' ? music : effects).model}
                act={act}
              />
            ))}
          </div>
          <div className="row wrap">
            <button
              className="button"
              onClick={() => {
                add('effect');
              }}
            >
              <PlusIcon aria-hidden="true" /> Add sound effect
            </button>
            <button
              className="button"
              onClick={() => {
                add('music');
              }}
            >
              <PlusIcon aria-hidden="true" /> Add music
            </button>
          </div>
        </>
      )}
    </>
  );
}
