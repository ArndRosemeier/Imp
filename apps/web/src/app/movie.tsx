import type { Project } from '@imp/core';
import { Character, Development, IMAGE_MODEL_SETTING, Scene } from '@imp/mode-movie';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FilmSlateIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactElement, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive, type Live } from './context.js';
import { ConfirmButton, EditableField } from './Field.js';

const SceneList = z.object({ scenes: z.array(Scene) });
const CharacterList = z.object({ characters: z.array(Character) });

const moviePrefix = (project: Project): string => `projects/${project.id}/movie/`;

/** Runs a movie command on the project and reports failures in the view. */
function useAct(project: Project): {
  act: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  error: string | null;
} {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    act: async (id, input) => {
      setError(null);
      try {
        return await runCommand(imp, id, { projectId: project.id, ...input });
      } catch (reason) {
        setError(messageOf(reason));
        return undefined;
      }
    },
  };
}

function Problem({ text }: { text: string | null }): ReactElement | null {
  return text === null ? null : (
    <p className="error" role="alert">
      {text}
    </p>
  );
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
        <h1>Start a movie</h1>
        <span className="muted">Give it a working title. You can change it at any time.</span>
      </div>
      <form className="card stack start" onSubmit={submit}>
        <div className="field">
          <label htmlFor="movie-title">Working title</label>
          <input
            id="movie-title"
            className="input"
            value={name}
            placeholder="The Lighthouse Keeper"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <Problem text={error} />
        <div className="row">
          <button className="button primary" disabled={name.trim() === ''}>
            <FilmSlateIcon aria-hidden="true" /> Start the movie
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
  { key: 'logline', label: 'Logline', rows: 2, placeholder: 'The film in one or two sentences.' },
  {
    key: 'premise',
    label: 'Premise',
    rows: 4,
    placeholder: 'The situation, the main character and what is at stake.',
  },
  { key: 'tone', label: 'Tone and style', rows: 3, placeholder: 'Genre, mood and visual style.' },
  {
    key: 'treatment',
    label: 'Treatment',
    rows: 14,
    placeholder: 'The story told in prose from beginning to end.',
  },
];

export function DevelopmentView({ project }: { project: Project }): ReactElement {
  const development = useLive([moviePrefix(project)], async (imp) =>
    Development.parse(await runCommand(imp, 'movie.development.get', { projectId: project.id })),
  );
  const { act, error } = useAct(project);
  return (
    <>
      <div className="view-head">
        <h1>Development</h1>
        <span className="muted">
          What the film is, before there is a script. Write it yourself or ask the Screenwriter.
        </span>
      </div>
      <Problem text={development.error ?? error} />
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
  const { act, error } = useAct(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scenes = listed.data?.scenes ?? [];
  const scene = scenes.find((candidate) => candidate.id === selectedId) ?? scenes[0];

  const add = (): void => {
    void act('movie.scene.create', { heading: '' }).then((created) => {
      if (created !== undefined) setSelectedId(Scene.parse(created).id);
    });
  };

  return (
    <>
      <div className="view-head">
        <h1>Script</h1>
        <span className="muted">
          {scenes.length === 1 ? '1 scene' : `${String(scenes.length)} scenes`}
        </span>
      </div>
      <Problem text={listed.error ?? error} />
      <div className="chips" role="tablist" aria-label="Scenes">
        {scenes.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            className="chip"
            aria-selected={candidate.id === scene?.id}
            onClick={() => {
              setSelectedId(candidate.id);
            }}
          >
            <span>
              {candidate.position} · {candidate.heading === '' ? 'Untitled' : candidate.heading}
            </span>
          </button>
        ))}
        <button className="chip add" onClick={add}>
          <PlusIcon aria-hidden="true" /> Add scene
        </button>
      </div>
      {scene === undefined ? (
        listed.data !== undefined && (
          <p className="muted">
            There are no scenes yet. Add one, or ask the Screenwriter to write the script from the
            development notes.
          </p>
        )
      ) : (
        <article
          key={scene.id}
          className="card stack page"
          aria-label={`Scene ${String(scene.position)}`}
        >
          <EditableField
            label="Scene heading"
            hideLabel
            script
            value={scene.heading}
            placeholder="INT. LOCATION - TIME"
            onCommit={(heading) => act('movie.scene.update', { sceneId: scene.id, heading })}
          />
          <EditableField
            label="Summary"
            value={scene.summary}
            placeholder="What happens in this scene, in a sentence or two."
            onCommit={(summary) => act('movie.scene.update', { sceneId: scene.id, summary })}
          />
          <EditableField
            label="Scene text"
            script
            rows={16}
            value={scene.body}
            placeholder="Action lines and dialogue."
            onCommit={(body) => act('movie.scene.update', { sceneId: scene.id, body })}
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
                <ArrowLeftIcon aria-hidden="true" /> Move earlier
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
                Move later <ArrowRightIcon aria-hidden="true" />
              </button>
            </div>
            <ConfirmButton
              label="Delete scene"
              question="Delete this scene for good?"
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
  { key: 'part', label: 'Part', placeholder: 'Protagonist, antagonist, the neighbour' },
  { key: 'description', label: 'Who they are', rows: 5, placeholder: 'Background, want, flaw.' },
  {
    key: 'appearance',
    label: 'Appearance',
    rows: 5,
    placeholder: 'Age, build, face, hair, clothing. Precise enough to draw from.',
  },
  { key: 'voice', label: 'Voice', rows: 4, placeholder: 'Pitch, pace, accent, manner.' },
];

const ImageModels = z.object({ models: z.array(z.object({ id: z.string(), name: z.string() })) });
const StringSetting = z.object({ value: z.json() });

/** Reads the setting that names the image model, and the models it can be set to. */
function useImageModel(): {
  model: string | null;
  models: readonly { id: string; name: string }[];
  error: string | null;
} {
  const setting = useLive([`settings/${IMAGE_MODEL_SETTING}`], async (imp) => {
    const { value } = StringSetting.parse(
      await runCommand(imp, 'settings.get', { key: IMAGE_MODEL_SETTING }),
    );
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
    runCommand(imp, 'models.list', { output: 'image' }).then(
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
  }, [imp]);
  return {
    model: setting.data ?? null,
    models: catalog.data?.models ?? [],
    error: setting.error ?? catalog.error,
  };
}

/** Turns a stored image into something an `img` can show, and frees it again afterwards. */
function useBlobUrl(blobKey: string | undefined): string | null {
  const imp = useImp();
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (blobKey === undefined) return undefined;
    let url: string | null = null;
    let active = true;
    void imp.blobs.get(blobKey).then((blob) => {
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
  act: (id: string, input: Record<string, unknown>) => Promise<unknown>;
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

  return (
    <div className="stack">
      <div className="portrait" aria-busy={busy}>
        {portrait === undefined ? (
          <span className="portrait-empty" aria-hidden="true">
            {character.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <StoredImage blobKey={portrait.blobKey} alt={`Portrait of ${character.name}`} />
        )}
        {busy && (
          <span className="portrait-busy" role="status">
            Developing…
          </span>
        )}
      </div>
      {character.images.length > 1 && (
        <div className="thumbs" role="group" aria-label={`Images of ${character.name}`}>
          {character.images.map((image, index) => (
            <button
              key={image.id}
              className="thumb"
              aria-pressed={image.id === character.portraitId}
              aria-label={`Use image ${String(index + 1)} as the portrait`}
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
          Direction for the next image
        </label>
        <input
          id={directionId}
          type="text"
          className="input"
          value={direction}
          placeholder="Direction, e.g. in profile, at night"
          onChange={(event) => {
            setDirection(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button"
          disabled={busy || model === null}
          title={model === null ? 'Choose an image model first.' : `Made with ${model}`}
        >
          <SparkleIcon aria-hidden="true" /> {portrait === undefined ? 'Portrait' : 'Another'}
        </button>
      </form>
      {portrait !== undefined && (
        <div className="row">
          <ConfirmButton
            label="Delete image"
            question="Delete this image for good?"
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

export function CastingView({ project }: { project: Project }): ReactElement {
  const listed = useLive([moviePrefix(project)], async (imp) =>
    CharacterList.parse(
      await runCommand(imp, 'movie.character.list', { projectId: project.id, full: true }),
    ),
  );
  const { act, error } = useAct(project);
  const images = useImageModel();
  const characters = listed.data?.characters ?? [];
  return (
    <>
      <div className="view-head">
        <h1>Casting</h1>
        <span className="muted">
          {characters.length === 1 ? '1 character' : `${String(characters.length)} characters`}
        </span>
        <button
          className="button"
          onClick={() => {
            void act('movie.character.create', { name: 'New character' });
          }}
        >
          <PlusIcon aria-hidden="true" /> Add character
        </button>
      </div>
      <div className="field image-model">
        <label htmlFor="image-model">Image model</label>
        <select
          id="image-model"
          className="select"
          value={images.model ?? ''}
          onChange={(event) => {
            void act('settings.set', { key: IMAGE_MODEL_SETTING, value: event.target.value });
          }}
        >
          {images.model === null && <option value="">Choose a model to make portraits</option>}
          {images.model !== null && !images.models.some(({ id }) => id === images.model) && (
            <option value={images.model}>{images.model}</option>
          )}
          {images.models.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <Problem text={listed.error ?? error ?? images.error} />
      {listed.data !== undefined && characters.length === 0 && (
        <p className="muted">
          Nobody is cast yet. Add a character, or ask the Casting Director to build the cast from
          the script.
        </p>
      )}
      <div className="grid cast">
        {characters.map((character) => (
          <article key={character.id} className="card stack" aria-label={character.name}>
            <div className="row">
              <EditableField
                label="Name"
                hideLabel
                value={character.name}
                onCommit={(name) =>
                  act('movie.character.update', { characterId: character.id, name })
                }
              />
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
            <div className="row">
              <ConfirmButton
                label="Delete character"
                question="Delete this character for good?"
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
