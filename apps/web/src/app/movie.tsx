import type { Project } from '@imp/core';
import {
  Character,
  Development,
  IMAGE_MODEL_SETTING,
  Scene,
  shortSceneTitle,
  SPEECH_MODEL_SETTING,
} from '@imp/mode-movie';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FilmSlateIcon,
  MicrophoneIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
  ScrollIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive, type Live } from './context.js';
import { WorkingOn } from './work.js';
import { ConfirmButton, EditableField } from './Field.js';
import { ScenePlace, useWorld } from './place.js';
import { useLibraryDrop } from './library/drag.js';
import { ModelBar } from './model-bar.js';
import { chooseModel, ModelChoice } from './model-choice.js';
import { Price } from './spend.js';
import { SceneScript, ScriptFiles } from './screenplay.js';
import { EmptyState } from './help/EmptyState.js';
import { canRetry, RetryNote, type Retry } from './retry.js';
import { t, tn } from '../i18n/i18n.js';

const SceneList = z.object({ scenes: z.array(Scene) });
const ScriptLength = z.object({ pages: z.number(), minutes: z.number() });
const ShotNumbers = z.object({
  shots: z.array(z.object({ id: z.string(), position: z.number() })),
});

/** Pages as scripts count them: in eighths, "1 4/8 pages". */
export function pagesText(pages: number): string {
  const eighths = Math.max(1, Math.round(pages * 8));
  const whole = Math.floor(eighths / 8);
  const rest = eighths % 8;
  const words =
    whole === 0
      ? `${String(rest)}/8`
      : rest === 0
        ? String(whole)
        : `${String(whole)} ${String(rest)}/8`;
  return `${words} ${eighths === 8 ? 'page' : 'pages'}`;
}

/** A running time in whole minutes, or under a minute. */
export function minutesText(minutes: number): string {
  if (minutes < 1) return t('under a minute');
  const whole = Math.round(minutes);
  return tn(whole, '{count} minute', '{count} minutes');
}
const CharacterList = z.object({ characters: z.array(Character) });

export const moviePrefix = (project: Project): string => `projects/${project.id}/movie/`;

/** Runs a movie command on the project and reports failures in the view. */
export function useAct(project: Project): {
  act: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  error: string | null;
  /** Sends the command that failed again, when the failure was outside Imp. */
  retry: Retry | null;
} {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<Retry | null>(null);
  const attempt = async (
    id: string,
    input: Record<string, unknown>,
    again: boolean,
  ): Promise<unknown> => {
    // A retry keeps its note up while it tries, so the spinner shows where the person pressed.
    if (!again) {
      setError(null);
      setRetry(null);
    }
    try {
      const output = await runCommand(imp, id, { projectId: project.id, ...input });
      setError(null);
      setRetry(null);
      return output;
    } catch (reason) {
      const text = messageOf(reason);
      setError(text);
      setRetry(canRetry(reason) ? { text, run: () => attempt(id, input, true) } : null);
      return undefined;
    }
  };
  return {
    error,
    retry,
    act: (id, input) => attempt(id, input, false),
  };
}

/**
 * A failure shown above a view. When it is the one a retry belongs to, it
 * comes with a Retry button that sends the same command again.
 */
export function Problem({
  text,
  retry = null,
}: {
  text: string | null;
  retry?: Retry | null;
}): ReactElement | null {
  if (text === null) return null;
  return <RetryNote text={text} onRetry={retry?.text === text ? retry.run : undefined} />;
}

/** Shown in place of a stage while no movie project is open. */
export function StartMovie({ onCreated }: { onCreated: (project: Project) => void }): ReactElement {
  const imp = useImp();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    runCommand(imp, 'project.create', { name: name.trim(), mode: 'movie' }).then(
      (project) => {
        onCreated(project as Project);
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };
  return (
    <>
      <div className="view-head">
        <h1>{t('Start a movie')}</h1>
        <span className="muted">
          {t('Give it a working title. You can change it at any time.')}
        </span>
      </div>
      <form className="card stack start" onSubmit={submit}>
        <div className="field">
          <label htmlFor="movie-title">{t('Working title')}</label>
          <input
            id="movie-title"
            className="input"
            value={name}
            placeholder={t('The Lighthouse Keeper')}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <Problem text={error} />
        <div className="row">
          <button className="button primary" disabled={name.trim() === ''}>
            <FilmSlateIcon aria-hidden="true" /> {t('Start the movie')}
          </button>
        </div>
      </form>
    </>
  );
}

const DEVELOPMENT_FIELDS: readonly {
  key: keyof Development;
  label: string;
  rows?: number;
  placeholder: string;
}[] = [
  {
    key: 'logline',
    get label(): string {
      return t('Logline');
    },
    rows: 2,
    get placeholder(): string {
      return t('The film in one or two sentences.');
    },
  },
  {
    key: 'premise',
    get label(): string {
      return t('Premise');
    },
    rows: 4,
    get placeholder(): string {
      return t('The situation, the main character and what is at stake.');
    },
  },
  {
    key: 'tone',
    get label(): string {
      return t('Tone and style');
    },
    rows: 3,
    get placeholder(): string {
      return t('Genre, mood and visual style.');
    },
  },
  {
    key: 'treatment',
    get label(): string {
      return t('Treatment');
    },
    rows: 14,
    get placeholder(): string {
      return t('The story told in prose from beginning to end.');
    },
  },
];

export function DevelopmentView({ project }: { project: Project }): ReactElement {
  const development = useLive([moviePrefix(project)], async (imp) =>
    Development.parse(await runCommand(imp, 'movie.development.get', { projectId: project.id })),
  );
  const { act, error, retry } = useAct(project);
  return (
    <>
      <div className="view-head">
        <h1>{t('Development')}</h1>
        <span className="muted">
          {t(
            'What the film is, before there is a script. Write it yourself or ask the Screenwriter.',
          )}
        </span>
      </div>
      <Problem text={development.error ?? error} retry={retry} />
      {development.data !== undefined && (
        <div className="card stack page">
          {DEVELOPMENT_FIELDS.map(({ key, label, rows, placeholder }) => (
            <EditableField
              key={key}
              label={label}
              value={development.data?.[key] ?? ''}
              placeholder={placeholder}
              {...(rows === undefined ? {} : { rows })}
              onCommit={(value) => act('movie.development.update', { [key]: value })}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function ScriptView({ project }: { project: Project }): ReactElement {
  const listed = useLive([moviePrefix(project)], async (imp) =>
    SceneList.parse(
      await runCommand(imp, 'movie.scene.list', { projectId: project.id, full: true }),
    ),
  );
  const { act, error, retry } = useAct(project);
  const world = useWorld(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scenes = listed.data?.scenes ?? [];
  const scene = scenes.find((candidate) => candidate.id === selectedId) ?? scenes[0];
  const sceneId = scene?.id;
  const extra = useLive(
    [moviePrefix(project), `${moviePrefix(project)}scenes/${sceneId ?? ''}`],
    async (imp) => ({
      length: ScriptLength.parse(
        await runCommand(imp, 'movie.script.get', { projectId: project.id }),
      ),
      cast: CharacterList.parse(
        await runCommand(imp, 'movie.character.list', { projectId: project.id, full: true }),
      ).characters.map((character) => character.name),
      shots:
        sceneId === undefined
          ? []
          : ShotNumbers.parse(
              await runCommand(imp, 'movie.shot.list', { projectId: project.id, sceneId }),
            ).shots,
    }),
  );
  const shotNumbers = new Map(
    (extra.data?.shots ?? []).map((shot) => [shot.id, shot.position] as const),
  );
  const length = extra.data?.length;

  const add = (): void => {
    void act('movie.scene.create', { heading: '' }).then((created) => {
      if (created !== undefined) setSelectedId(Scene.parse(created).id);
    });
  };

  return (
    <>
      <div className="view-head">
        <h1>{t('Script')}</h1>
        <span className="muted">
          {tn(scenes.length, '{count} scene', '{count} scenes')}
          {length !== undefined && length.pages > 0 && (
            <>
              {' '}
              {t('· {pages} · about {minutes}', {
                pages: pagesText(length.pages),
                minutes: minutesText(length.minutes),
              })}
            </>
          )}
        </span>
      </div>
      <ScriptFiles project={project} onImported={setSelectedId} />
      <Problem text={listed.error ?? error} retry={retry} />
      <div className="chips" role="tablist" aria-label={t('Scenes')}>
        {scenes.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            className="chip"
            title={candidate.heading || undefined}
            aria-selected={candidate.id === scene?.id}
            onClick={() => {
              setSelectedId(candidate.id);
            }}
          >
            <span>
              {candidate.position} · {shortSceneTitle(candidate.heading)}
            </span>
            <WorkingOn kind="scene" id={candidate.id} compact />
          </button>
        ))}
        <button className="chip add" onClick={add}>
          <PlusIcon aria-hidden="true" /> {t('Add scene')}
        </button>
      </div>
      {scene === undefined ? (
        listed.data !== undefined && (
          <EmptyState
            icon={ScrollIcon}
            title={t('No scenes yet')}
            quip={t('A blank page. The imp finds that very tempting.')}
            body={t(
              'There are no scenes yet. Add one with Add scene, or have the script written from the development notes.',
            )}
            ask={t('Write the script of this film from the development notes, scene by scene.')}
          />
        )
      ) : (
        <article
          key={scene.id}
          className="card stack page"
          aria-label={t('Scene {position}', { position: String(scene.position) })}
        >
          <WorkingOn kind="scene" id={scene.id} />
          <EditableField
            label={t('Scene heading')}
            hideLabel
            script
            heading
            value={scene.heading}
            placeholder={t('INT. LOCATION - TIME')}
            onCommit={(heading) => act('movie.scene.update', { sceneId: scene.id, heading })}
          />
          <ScenePlace
            sceneId={scene.id}
            locationId={scene.locationId}
            stateId={scene.locationStateId}
            locations={world.locations}
            act={act}
          />
          <EditableField
            label={t('Summary')}
            value={scene.summary}
            placeholder={t('What happens in this scene, in a sentence or two.')}
            onCommit={(summary) => act('movie.scene.update', { sceneId: scene.id, summary })}
          />
          <SceneScript
            project={project}
            sceneId={scene.id}
            heading={scene.heading}
            body={scene.body}
            cast={extra.data?.cast ?? []}
            shotNumbers={shotNumbers}
            act={act}
          />
          <div className="row spread wrap">
            <div className="row">
              <button
                className="button quiet"
                disabled={scene.position === 1}
                onClick={() => {
                  void act('movie.scene.update', {
                    sceneId: scene.id,
                    position: scene.position - 1,
                  });
                }}
              >
                <ArrowLeftIcon aria-hidden="true" /> {t('Move earlier')}
              </button>
              <button
                className="button quiet"
                disabled={scene.position === scenes.length}
                onClick={() => {
                  void act('movie.scene.update', {
                    sceneId: scene.id,
                    position: scene.position + 1,
                  });
                }}
              >
                {t('Move later')} <ArrowRightIcon aria-hidden="true" />
              </button>
            </div>
            <ConfirmButton
              label={t('Delete scene')}
              question={t('Delete this scene for good?')}
              onConfirm={() => {
                void act('movie.scene.delete', { sceneId: scene.id });
              }}
            >
              <TrashIcon aria-hidden="true" />
            </ConfirmButton>
          </div>
        </article>
      )}
    </>
  );
}

const CHARACTER_FIELDS: readonly {
  key: 'part' | 'description' | 'appearance' | 'voice';
  label: string;
  rows?: number;
  placeholder: string;
}[] = [
  {
    key: 'part',
    get label(): string {
      return t('Part');
    },
    get placeholder(): string {
      return t('Protagonist, antagonist, the neighbour');
    },
  },
  {
    key: 'description',
    get label(): string {
      return t('Who they are');
    },
    rows: 5,
    get placeholder(): string {
      return t('Background, want, flaw.');
    },
  },
  {
    key: 'appearance',
    get label(): string {
      return t('Appearance');
    },
    rows: 5,
    get placeholder(): string {
      return t('Age, build, face, hair, clothing. Precise enough to draw from.');
    },
  },
  {
    key: 'voice',
    get label(): string {
      return t('Voice');
    },
    rows: 4,
    get placeholder(): string {
      return t('Pitch, pace, accent, manner.');
    },
  },
];

const ImageModels = z.object({
  models: z.array(
    z.object({ id: z.string(), name: z.string(), abilities: z.array(z.string()).optional() }),
  ),
});
const StringSetting = z.object({ value: z.json() });

/** What kind of thing a model setting's model makes, for asking the catalog. */
export type ModelOutput = 'text' | 'image' | 'speech' | 'audio' | 'video' | 'transcription';

/** Reads a setting that names a generation model, and the models it can be set to. */
export function useModelSetting(
  key: string,
  output: ModelOutput,
  options: { tools?: boolean } = {},
): {
  model: string | null;
  models: readonly { id: string; name: string; abilities?: string[] | undefined }[];
  error: string | null;
  output: ModelOutput;
  tools: boolean;
} {
  const tools = options.tools ?? false;
  const setting = useLive([`settings/${key}`], async (imp) => {
    const { value } = StringSetting.parse(await runCommand(imp, 'settings.get', { key }));
    return typeof value === 'string' && value !== '' ? value : null;
  });
  // The catalog does not live in the store, so it is read once per visit.
  const imp = useImp();
  const [catalog, setCatalog] = useState<Live<z.infer<typeof ImageModels>>>({
    data: undefined,
    error: null,
  });
  useEffect(() => {
    let active = true;
    runCommand(imp, 'models.list', { output, tools }).then(
      (listed) => {
        if (active) setCatalog({ data: ImageModels.parse(listed), error: null });
      },
      (reason: unknown) => {
        if (active) setCatalog({ data: undefined, error: messageOf(reason) });
      },
    );
    return () => {
      active = false;
    };
  }, [imp, output, tools]);
  return {
    model: setting.data ?? null,
    models: catalog.data?.models ?? [],
    error: setting.error ?? catalog.error,
    output,
    tools,
  };
}

/** Turns a stored image into something an `img` can show, and frees it again afterwards. */
export function useBlobUrl(blobKey: string | undefined): string | null {
  const imp = useImp();
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (blobKey === undefined) return undefined;
    let url: string | null = null;
    let active = true;
    void imp.blob(blobKey).then((blob) => {
      if (!active || blob === undefined) return;
      url = URL.createObjectURL(new Blob([blob.bytes.slice()], { type: blob.mediaType }));
      setShown({ key: blobKey, url });
    });
    return () => {
      active = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [imp, blobKey]);
  return shown !== null && shown.key === blobKey ? shown.url : null;
}

function StoredImage({ blobKey, alt }: { blobKey: string; alt: string }): ReactElement | null {
  const url = useBlobUrl(blobKey);
  return url === null ? null : <img src={url} alt={alt} />;
}

function CharacterImages({
  character,
  model,
  act,
}: {
  character: Character;
  model: string | null;
  act: Act;
}): ReactElement {
  const directionId = useId();
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const portrait = character.images.find((image) => image.id === character.portraitId);
  const at = { characterId: character.id };

  const generate = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    void act('movie.character.image.generate', {
      ...at,
      ...(direction.trim() === '' ? {} : { direction: direction.trim() }),
    }).finally(() => {
      setBusy(false);
    });
  };

  // A picture from the library becomes an image of the character, and its portrait.
  const portraitBox = useRef<HTMLDivElement>(null);
  useLibraryDrop(portraitBox, {
    label: t('{name}, portrait', { name: character.name }),
    accepts: (asset) => asset.modality === 'image' && asset.blobKey !== null,
    onDrop: async (asset) => {
      await act('movie.character.image.fromFile', { ...at, blobKey: asset.blobKey });
    },
  });
  return (
    <div className="stack">
      <div className="portrait" aria-busy={busy} ref={portraitBox}>
        {portrait === undefined ? (
          <span className="portrait-empty" aria-hidden="true">
            {character.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <StoredImage
            blobKey={portrait.blobKey}
            alt={t('Portrait of {name}', { name: character.name })}
          />
        )}
        {busy && (
          <span className="portrait-busy" role="status">
            {t('Developing…')}
          </span>
        )}
      </div>
      {character.images.length > 1 && (
        <div
          className="thumbs"
          role="group"
          aria-label={t('Images of {name}', { name: character.name })}
        >
          {character.images.map((image, index) => (
            <button
              key={image.id}
              className="thumb"
              aria-pressed={image.id === character.portraitId}
              aria-label={t('Use image {value} as the portrait', { value: String(index + 1) })}
              title={image.prompt}
              onClick={() => {
                void act('movie.character.image.select', { ...at, imageId: image.id });
              }}
            >
              <StoredImage blobKey={image.blobKey} alt="" />
            </button>
          ))}
        </div>
      )}
      <form className="row portrait-make" onSubmit={generate}>
        <label className="sr-only" htmlFor={directionId}>
          {t('Direction for the next image')}
        </label>
        <input
          id={directionId}
          type="text"
          className="input"
          value={direction}
          placeholder={t('Direction, e.g. in profile, at night')}
          onChange={(event) => {
            setDirection(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button"
          disabled={busy || model === null}
          title={
            model === null ? t('Choose an image model first.') : t('Made with {model}', { model })
          }
        >
          <SparkleIcon aria-hidden="true" /> {portrait === undefined ? t('Portrait') : t('Another')}
          <Price command="movie.character.image.generate" input={at} />
        </button>
      </form>
      {portrait !== undefined && (
        <div className="row">
          <ConfirmButton
            label={t('Delete image')}
            question={t('Delete this image for good?')}
            onConfirm={() => {
              void act('movie.character.image.delete', { ...at, imageId: portrait.id });
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}

export type Act = (id: string, input: Record<string, unknown>) => Promise<unknown>;

export function ModelPicker({
  id,
  label,
  empty,
  setting,
  choice,
  act,
}: {
  id: string;
  label: string;
  empty: string;
  setting: string;
  choice: ReturnType<typeof useModelSetting>;
  act: Act;
}): ReactElement {
  return (
    <ModelChoice
      id={id}
      label={label}
      empty={empty}
      output={choice.output}
      tools={choice.tools}
      value={choice.model}
      known={choice.models}
      onChoose={(model) => chooseModel(act, setting, model)}
    />
  );
}

/** The recording of a character's voice: play it, and record a line with a delivery. */
function CharacterVoice({
  character,
  model,
  act,
}: {
  character: Character;
  model: string | null;
  act: Act;
}): ReactElement {
  const lineId = useId();
  const deliveryId = useId();
  const [line, setLine] = useState('');
  const [delivery, setDelivery] = useState('');
  const [busy, setBusy] = useState(false);
  const sample = character.voiceSample;
  const url = useBlobUrl(sample?.blobKey);
  const at = { characterId: character.id };

  const record = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    void act('movie.character.voice.generate', {
      ...at,
      ...(line.trim() === '' ? {} : { line: line.trim() }),
      ...(delivery.trim() === '' ? {} : { delivery: delivery.trim() }),
    }).finally(() => {
      setBusy(false);
    });
  };

  return (
    <form
      className="stack voice"
      onSubmit={record}
      aria-label={t('Voice of {name}', { name: character.name })}
    >
      {sample !== null && (
        <figure className="voice-sample">
          {url !== null && (
            // The words spoken are the caption below; a generated clip has no caption track.
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio
              controls
              src={url}
              aria-label={t('Voice sample of {name}', { name: character.name })}
            />
          )}
          <figcaption className="muted">“{sample.line}”</figcaption>
        </figure>
      )}
      <div className="field">
        <label htmlFor={lineId}>{t('Line to record')}</label>
        <input
          id={lineId}
          type="text"
          className="input"
          value={line}
          placeholder={t('Hello. My name is {name}.', { name: character.name })}
          onChange={(event) => {
            setLine(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={deliveryId}>{t('Delivery')}</label>
        <input
          id={deliveryId}
          type="text"
          className="input"
          value={delivery}
          placeholder={t('Shouting over a storm, out of breath')}
          onChange={(event) => {
            setDelivery(event.target.value);
          }}
        />
      </div>
      <div className="row wrap">
        <button
          type="submit"
          className="button"
          disabled={busy || model === null}
          title={
            model === null ? t('Choose a voice model first.') : t('Spoken by {model}', { model })
          }
        >
          <MicrophoneIcon aria-hidden="true" />{' '}
          {busy ? t('Recording…') : sample === null ? t('Record voice') : t('Record again')}
          {!busy && (
            <Price
              command="movie.character.voice.generate"
              input={line.trim() === '' ? at : { ...at, line: line.trim() }}
            />
          )}
        </button>
        {sample !== null && (
          <ConfirmButton
            label={t('Delete recording')}
            question={t('Delete this recording for good?')}
            onConfirm={() => {
              void act('movie.character.voice.delete', at);
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        )}
      </div>
    </form>
  );
}

export function CastingView({ project }: { project: Project }): ReactElement {
  const listed = useLive([moviePrefix(project)], async (imp) =>
    CharacterList.parse(
      await runCommand(imp, 'movie.character.list', { projectId: project.id, full: true }),
    ),
  );
  const { act, error, retry } = useAct(project);
  const images = useModelSetting(IMAGE_MODEL_SETTING, 'image');
  const speech = useModelSetting(SPEECH_MODEL_SETTING, 'speech');
  const characters = listed.data?.characters ?? [];
  return (
    <>
      <div className="view-head">
        <h1>{t('Casting')}</h1>
        <span className="muted">
          {tn(characters.length, '{count} character', '{count} characters')}
        </span>
        <button
          className="button"
          onClick={() => {
            void act('movie.character.create', { name: t('New character') });
          }}
        >
          <PlusIcon aria-hidden="true" /> {t('Add character')}
        </button>
      </div>
      <ModelBar
        act={act}
        models={[
          {
            id: 'image-model',
            label: t('Image'),
            empty: t('Choose a model to make portraits'),
            setting: IMAGE_MODEL_SETTING,
            choice: images,
          },
          {
            id: 'speech-model',
            label: t('Voice'),
            empty: t('Choose a model to record voices'),
            setting: SPEECH_MODEL_SETTING,
            choice: speech,
          },
        ]}
      />
      <Problem text={listed.error ?? error ?? images.error ?? speech.error} retry={retry} />
      {listed.data !== undefined && characters.length === 0 && (
        <EmptyState
          icon={UsersThreeIcon}
          title={t('Nobody is cast yet')}
          quip={t('An empty stage, and the imp is bored already.')}
          body={t(
            'Nobody is cast yet. Add a character, or have the cast built from the script, with a look and a voice for each.',
          )}
          ask={t(
            'Build the cast of this film from the script: who appears, how they look and sound. Tell me the price before making portraits.',
          )}
        />
      )}
      <div className="grid cast">
        {characters.map((character) => (
          <article key={character.id} className="card stack" aria-label={character.name}>
            <div className="row">
              <EditableField
                label={t('Name')}
                hideLabel
                value={character.name}
                onCommit={(name) =>
                  act('movie.character.update', { characterId: character.id, name })
                }
              />
              <WorkingOn kind="character" id={character.id} />
            </div>
            <CharacterImages character={character} model={images.model} act={act} />
            {CHARACTER_FIELDS.map(({ key, label, rows, placeholder }) => (
              <EditableField
                key={key}
                label={label}
                value={character[key]}
                placeholder={placeholder}
                {...(rows === undefined ? {} : { rows })}
                onCommit={(value) =>
                  act('movie.character.update', { characterId: character.id, [key]: value })
                }
              />
            ))}
            <label className="row">
              <input
                type="checkbox"
                checked={character.voiceOnly}
                onChange={(event) => {
                  void act('movie.character.update', {
                    characterId: character.id,
                    voiceOnly: event.target.checked,
                  });
                }}
              />
              {t('Voice only (a narrator: heard, never seen)')}
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={character.ownLane}
                onChange={(event) => {
                  void act('movie.character.update', {
                    characterId: character.id,
                    ownLane: event.target.checked,
                  });
                }}
              />
              {t('Own lane in the Edit stage (lines placed in time)')}
            </label>
            <CharacterVoice character={character} model={speech.model} act={act} />
            <div className="row">
              <ConfirmButton
                label={t('Delete character')}
                question={t('Delete this character for good?')}
                onConfirm={() => {
                  void act('movie.character.delete', { characterId: character.id });
                }}
              >
                <TrashIcon aria-hidden="true" />
              </ConfirmButton>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
