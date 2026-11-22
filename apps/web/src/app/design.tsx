import type { Project } from '@imp/core';
import { Character, IMAGE_MODEL_SETTING } from '@imp/mode-movie';
import {
  keyImageOf,
  WorldElement,
  type State,
  type View,
  type WorldImage,
  type WorldKind,
} from '@imp/world';
import { CubeIcon, MapPinIcon, PlusIcon, SparkleIcon, TrashIcon } from '@phosphor-icons/react';
import { useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { useLibraryDrop } from './library/drag.js';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { WorkingOn } from './work.js';
import { ConfirmButton, EditableField } from './Field.js';
import { moviePrefix, Problem, useAct, useBlobUrl, useModelSetting, type Act } from './movie.js';
import { ModelBar } from './model-bar.js';
import { Price } from './spend.js';
import { t, tn } from '../i18n/i18n.js';

const Items = z.object({ items: z.array(WorldElement) });
const Cast = z.object({ characters: z.array(Character.pick({ id: true, name: true })) });

export const worldPrefix = (project: Project): string => `projects/${project.id}/world/`;

interface KindText {
  readonly tab: string;
  readonly empty: string;
  readonly idKey: string;
  readonly noView: string;
  readonly remove: string;
  readonly removeQuestion: string;
  readonly newName: string;
  readonly add: string;
}

// Each kind has its own sentences, because languages such as German change the words around a noun.
const KIND_TEXT: Readonly<Record<WorldKind, KindText>> = {
  location: {
    idKey: 'locationId',
    get tab(): string {
      return t('Locations');
    },
    get empty(): string {
      return t(
        'No places yet. Add one, or ask the Production Designer to find the locations in the script.',
      );
    },
    get noView(): string {
      return t('This location has no view.');
    },
    get remove(): string {
      return t('Delete location');
    },
    get removeQuestion(): string {
      return t('Delete this location and its pictures for good?');
    },
    get newName(): string {
      return t('New location');
    },
    get add(): string {
      return t('Add location');
    },
  },
  object: {
    idKey: 'objectId',
    get tab(): string {
      return t('Objects');
    },
    get empty(): string {
      return t(
        'No objects yet. Add the props that matter to the story, or ask the Production Designer.',
      );
    },
    get noView(): string {
      return t('This object has no view.');
    },
    get remove(): string {
      return t('Delete object');
    },
    get removeQuestion(): string {
      return t('Delete this object and its pictures for good?');
    },
    get newName(): string {
      return t('New object');
    },
    get add(): string {
      return t('Add object');
    },
  },
};

function Picture({
  image,
  alt,
  className,
}: {
  image: WorldImage | undefined;
  alt: string;
  className?: string;
}): ReactElement | null {
  const url = useBlobUrl(image?.blobKey);
  return url === null ? null : <img src={url} alt={alt} className={className} />;
}

/** The pictures of one view in one state, the key one large, the others to choose from. */
function Stage({
  element,
  view,
  state,
  model,
  act,
}: {
  element: WorldElement;
  view: View;
  state: State | null;
  model: string | null;
  act: Act;
}): ReactElement {
  const directionId = useId();
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const at = { [KIND_TEXT[element.kind].idKey]: element.id };
  const pictures = element.images.filter(
    (image) => image.viewId === view.id && image.stateId === (state?.id ?? null),
  );
  const keyId = element.keyImages.find(
    (key) => key.viewId === view.id && key.stateId === (state?.id ?? null),
  )?.imageId;
  const key = pictures.find((image) => image.id === keyId);
  const fallback = key ?? keyImageOf(element, view.id, state?.id ?? null);
  const where = `${element.name}, ${view.name}${state === null ? '' : `, ${state.name}`}`;
  const isMaster = element.views[0]?.id === view.id;

  const generate = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    void act(`world.${element.kind}.image.generate`, {
      ...at,
      viewId: view.id,
      stateId: state?.id ?? null,
      ...(direction.trim() === '' ? {} : { direction: direction.trim() }),
    }).finally(() => {
      setBusy(false);
    });
  };

  // A picture from the library becomes a picture of this view in this state, and its key picture.
  const plate = useRef<HTMLDivElement>(null);
  useLibraryDrop(plate, {
    label: where,
    accepts: (asset) => asset.modality === 'image' && asset.blobKey !== null,
    onDrop: async (asset) => {
      await act(`world.${element.kind}.image.fromFile`, {
        ...at,
        blobKey: asset.blobKey,
        viewId: view.id,
        stateId: state?.id ?? null,
      });
    },
  });
  return (
    <div className="stack">
      <div className={`plate ${element.kind}`} aria-busy={busy} ref={plate}>
        {fallback === undefined ? (
          <span className="plate-empty">
            {isMaster
              ? t(
                  'Draw the master view first: every other view and state is drawn to agree with it.',
                )
              : t('Not drawn yet. It will be drawn to agree with the pictures already made.')}
          </span>
        ) : (
          <Picture image={fallback} alt={where} />
        )}
        {key === undefined && fallback !== undefined && (
          <span className="plate-note">{t('Stand-in: the closest picture there is')}</span>
        )}
        {busy && (
          <span className="portrait-busy" role="status">
            {t('Developing…')}
          </span>
        )}
      </div>
      {pictures.length > 1 && (
        <div className="thumbs wide" role="group" aria-label={t('Pictures of {where}', { where })}>
          {pictures.map((image, index) => (
            <button
              key={image.id}
              className="thumb"
              aria-pressed={image.id === keyId}
              aria-label={t('Use picture {value} as the key picture', { value: String(index + 1) })}
              title={image.prompt}
              onClick={() => {
                void act(`world.${element.kind}.image.select`, { ...at, imageId: image.id });
              }}
            >
              <Picture image={image} alt="" />
            </button>
          ))}
        </div>
      )}
      <form className="row portrait-make" onSubmit={generate}>
        <label className="sr-only" htmlFor={directionId}>
          {t('Direction for the next picture')}
        </label>
        <input
          id={directionId}
          type="text"
          className="input"
          value={direction}
          placeholder={t('Direction, e.g. warmer light, less clutter')}
          onChange={(event) => {
            setDirection(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button"
          disabled={busy || model === null}
          title={
            model === null ? t('Choose an image model first.') : t('Drawn by {model}', { model })
          }
        >
          <SparkleIcon aria-hidden="true" /> {key === undefined ? t('Draw') : t('Another')}
          <Price
            command={`world.${element.kind}.image.generate`}
            input={{ ...at, viewId: view.id, stateId: state?.id ?? null }}
          />
        </button>
      </form>
      {key !== undefined && (
        <div className="row wrap">
          <span className="muted small">
            {key.references === 0
              ? t('Drawn from the words alone.')
              : tn(
                  key.references,
                  'Drawn to agree with {count} picture.',
                  'Drawn to agree with {count} pictures.',
                )}
          </span>
          <ConfirmButton
            label={t('Delete picture')}
            question={t('Delete this picture for good?')}
            onConfirm={() => {
              void act(`world.${element.kind}.image.delete`, { ...at, imageId: key.id });
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}

/**
 * Every view in every state at a glance: rows are camera positions, columns
 * are states. Choosing a cell shows it large.
 */
function ContactSheet({
  element,
  viewId,
  stateId,
  onPick,
}: {
  element: WorldElement;
  viewId: string;
  stateId: string | null;
  onPick: (viewId: string, stateId: string | null) => void;
}): ReactElement {
  const columns: (State | null)[] = [null, ...element.states];
  return (
    <div className="sheet-scroll">
      <table className="sheet" aria-label={t('Views and states of {name}', { name: element.name })}>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">{t('View')}</span>
            </th>
            {columns.map((state) => (
              <th key={state?.id ?? 'usual'} scope="col">
                {state === null ? t('Usual') : state.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {element.views.map((view, row) => (
            <tr key={view.id}>
              <th scope="row">
                {view.name}
                {row === 0 && <span className="tag neutral">{t('Master')}</span>}
              </th>
              {columns.map((state) => {
                const exact = element.keyImages.find(
                  (key) => key.viewId === view.id && key.stateId === (state?.id ?? null),
                );
                const image = element.images.find((candidate) => candidate.id === exact?.imageId);
                const label = `${view.name}, ${state === null ? t('usual look') : state.name}`;
                return (
                  <td key={state?.id ?? 'usual'}>
                    <button
                      type="button"
                      className="sheet-cell"
                      aria-pressed={view.id === viewId && (state?.id ?? null) === stateId}
                      aria-label={image === undefined ? t('{label}, not drawn', { label }) : label}
                      onClick={() => {
                        onPick(view.id, state?.id ?? null);
                      }}
                    >
                      {image === undefined ? (
                        <PlusIcon aria-hidden="true" />
                      ) : (
                        <Picture image={image} alt="" />
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A small form to add a view or a state by name. */
function AddNamed({
  label,
  placeholder,
  onAdd,
}: {
  label: string;
  placeholder: string;
  onAdd: (name: string) => Promise<unknown>;
}): ReactElement {
  const id = useId();
  const [name, setName] = useState('');
  return (
    <form
      className="row add-named"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed === '') return;
        void onAdd(trimmed).then(() => {
          setName('');
        });
      }}
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        value={name}
        placeholder={placeholder}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <button type="submit" className="button quiet" disabled={name.trim() === ''}>
        <PlusIcon aria-hidden="true" /> {label}
      </button>
    </form>
  );
}

function ElementEditor({
  element,
  locations,
  cast,
  model,
  act,
}: {
  element: WorldElement;
  locations: readonly WorldElement[];
  cast: readonly { id: string; name: string }[];
  model: string | null;
  act: Act;
}): ReactElement {
  const relationId = useId();
  const kind = element.kind;
  const text = KIND_TEXT[kind];
  const at = { [text.idKey]: element.id };
  const [picked, setPicked] = useState<{ viewId: string; stateId: string | null } | null>(null);
  const view =
    element.views.find((candidate) => candidate.id === picked?.viewId) ?? element.views[0];
  const state = element.states.find((candidate) => candidate.id === picked?.stateId) ?? null;
  const change = (fields: Record<string, unknown>): Promise<unknown> =>
    act(`world.${kind}.update`, { ...at, ...fields });

  if (view === undefined) return <p className="muted">{text.noView}</p>;

  return (
    <article className="card stack design" aria-label={element.name}>
      <div className="row spread wrap">
        <EditableField
          label={t('Name')}
          hideLabel
          value={element.name}
          onCommit={(name) => change({ name })}
        />
        <WorkingOn kind={element.kind} id={element.id} />
        <ConfirmButton
          label={text.remove}
          question={text.removeQuestion}
          onConfirm={() => {
            void act(`world.${kind}.delete`, at);
          }}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      </div>

      <Stage element={element} view={view} state={state} model={model} act={act} />

      <ContactSheet
        element={element}
        viewId={view.id}
        stateId={state?.id ?? null}
        onPick={(viewId, stateId) => {
          setPicked({ viewId, stateId });
        }}
      />
      <div className="row wrap design-adds">
        <AddNamed
          label={t('Add view')}
          placeholder={kind === 'location' ? t('Toward the sea window') : t('In hand')}
          onAdd={(name) =>
            act(`world.${kind}.view.add`, { ...at, name }).then((made) => {
              const added = made as View | undefined;
              if (added !== undefined) setPicked({ viewId: added.id, stateId: state?.id ?? null });
            })
          }
        />
        <AddNamed
          label={t('Add state')}
          placeholder={kind === 'location' ? t('Night, storm') : t('Cracked')}
          onAdd={(name) =>
            act(`world.${kind}.state.add`, { ...at, name }).then((made) => {
              const added = made as State | undefined;
              if (added !== undefined) setPicked({ viewId: view.id, stateId: added.id });
            })
          }
        />
      </div>

      <section className="stack design-part" aria-label={t('View {name}', { name: view.name })}>
        <div className="row spread wrap">
          <h3>{t('View · {name}', { name: view.name })}</h3>
          {element.views.length > 1 && (
            <ConfirmButton
              label={t('Remove view')}
              question={t('Remove this view and its pictures?')}
              onConfirm={() => {
                setPicked(null);
                void act(`world.${kind}.view.remove`, { ...at, viewId: view.id });
              }}
            >
              <TrashIcon aria-hidden="true" />
            </ConfirmButton>
          )}
        </div>
        <EditableField
          label={t('View name')}
          value={view.name}
          onCommit={(name) => act(`world.${kind}.view.update`, { ...at, viewId: view.id, name })}
        />
        <EditableField
          label={t('Where the camera stands')}
          rows={2}
          value={view.description}
          placeholder={t(
            'Low in the stairwell door, looking up at the lamp; the sea window on the right.',
          )}
          onCommit={(description) =>
            act(`world.${kind}.view.update`, { ...at, viewId: view.id, description })
          }
        />
      </section>

      {state !== null && (
        <section className="stack design-part" aria-label={t('State {name}', { name: state.name })}>
          <div className="row spread wrap">
            <h3>{t('State · {name}', { name: state.name })}</h3>
            <ConfirmButton
              label={t('Remove state')}
              question={t('Remove this state and its pictures?')}
              onConfirm={() => {
                setPicked({ viewId: view.id, stateId: null });
                void act(`world.${kind}.state.remove`, { ...at, stateId: state.id });
              }}
            >
              <TrashIcon aria-hidden="true" />
            </ConfirmButton>
          </div>
          <EditableField
            label={t('State name')}
            value={state.name}
            onCommit={(name) =>
              act(`world.${kind}.state.update`, { ...at, stateId: state.id, name })
            }
          />
          <EditableField
            label={t('What differs')}
            rows={2}
            value={state.description}
            placeholder={t('Rain lashing the windows; only the lamp lights the room.')}
            onCommit={(description) =>
              act(`world.${kind}.state.update`, { ...at, stateId: state.id, description })
            }
          />
        </section>
      )}

      <section className="stack design-part" aria-label={t('Description')}>
        <EditableField
          label={t('What it is')}
          rows={3}
          value={element.description}
          placeholder={t('What it is and what it means in the story.')}
          onCommit={(description) => change({ description })}
        />
        <EditableField
          label={t('Look')}
          rows={4}
          value={element.look}
          placeholder={
            kind === 'location'
              ? t('Architecture, materials, colours, wear, light. Precise enough to draw from.')
              : t('Shape, size, materials, colours, wear. Precise enough to draw from.')
          }
          onCommit={(look) => change({ look })}
        />
        {element.kind === 'location' && (
          <>
            <EditableField
              label={t('Layout')}
              rows={3}
              value={element.layout}
              placeholder={t(
                'Where things are relative to each other: the door faces the sea window, the stairs come up in the middle.',
              )}
              onCommit={(layout) => change({ layout })}
            />
            <EditableField
              label={t('Ambience')}
              rows={2}
              value={element.ambience}
              placeholder={t('Wind in the iron frame, distant surf.')}
              onCommit={(ambience) => change({ ambience })}
            />
          </>
        )}
        <div className="field">
          <label htmlFor={relationId}>{kind === 'location' ? t('Part of') : t('Belongs to')}</label>
          <select
            id={relationId}
            className="select"
            value={(element.kind === 'location' ? element.parentId : element.ownerId) ?? ''}
            onChange={(event) => {
              const value = event.target.value === '' ? null : event.target.value;
              void change(kind === 'location' ? { parentId: value } : { ownerId: value });
            }}
          >
            <option value="">{kind === 'location' ? t('Nothing larger') : t('Nobody')}</option>
            {kind === 'object' &&
              cast.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            {locations
              .filter((place) => place.id !== element.id)
              .map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
          </select>
        </div>
      </section>
    </article>
  );
}

function KindPanel({
  project,
  kind,
  model,
}: {
  project: Project;
  kind: WorldKind;
  model: string | null;
}): ReactElement {
  const text = KIND_TEXT[kind];
  const listed = useLive([worldPrefix(project), moviePrefix(project)], async (imp) => ({
    items: Items.parse(
      await runCommand(imp, `world.${kind}.list`, { projectId: project.id, full: true }),
    ).items,
    locations:
      kind === 'object'
        ? Items.parse(
            await runCommand(imp, 'world.location.list', { projectId: project.id, full: true }),
          ).items
        : [],
    cast: Cast.parse(await runCommand(imp, 'movie.character.list', { projectId: project.id }))
      .characters,
  }));
  const { act, error } = useAct(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = listed.data?.items ?? [];
  const element = items.find((candidate) => candidate.id === selectedId) ?? items[0];

  const add = (): void => {
    void act(`world.${kind}.create`, { name: text.newName }).then((made) => {
      if (made !== undefined) setSelectedId((made as WorldElement).id);
    });
  };

  return (
    <>
      <Problem text={listed.error ?? error} />
      <div className="chips" role="tablist" aria-label={text.tab}>
        {items.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            className="chip with-thumb"
            aria-selected={candidate.id === element?.id}
            onClick={() => {
              setSelectedId(candidate.id);
            }}
          >
            <Picture image={keyImageOf(candidate)} alt="" className="chip-thumb" />
            <span>{candidate.name}</span>
          </button>
        ))}
        <button className="chip add" onClick={add}>
          <PlusIcon aria-hidden="true" /> {text.add}
        </button>
      </div>
      {element === undefined ? (
        listed.data !== undefined && <p className="muted">{text.empty}</p>
      ) : (
        <ElementEditor
          key={element.id}
          element={element}
          locations={kind === 'location' ? items : (listed.data?.locations ?? [])}
          cast={listed.data?.cast ?? []}
          model={model}
          act={act}
        />
      )}
    </>
  );
}

/** Production design: the places and objects of the film, each drawn from every side it is seen from. */
export function DesignView({ project }: { project: Project }): ReactElement {
  const { act, error } = useAct(project);
  const images = useModelSetting(IMAGE_MODEL_SETTING, 'image');
  const [kind, setKind] = useState<WorldKind>('location');
  return (
    <>
      <div className="view-head">
        <h1>{t('Design')}</h1>
        <span className="muted">
          {t('The places and objects of the film, drawn from every side the camera sees them.')}
        </span>
      </div>
      <div className="row wrap model-pickers">
        <div className="kind-switch" role="tablist" aria-label={t('Kind')}>
          {(['location', 'object'] as const).map((candidate) => (
            <button
              key={candidate}
              role="tab"
              aria-selected={kind === candidate}
              className="kind-segment"
              onClick={() => {
                setKind(candidate);
              }}
            >
              {candidate === 'location' ? (
                <MapPinIcon aria-hidden="true" />
              ) : (
                <CubeIcon aria-hidden="true" />
              )}
              {KIND_TEXT[candidate].tab}
            </button>
          ))}
        </div>
      </div>
      <ModelBar
        act={act}
        models={[
          {
            id: 'design-image-model',
            label: t('Image'),
            empty: t('Choose a model to draw pictures'),
            setting: IMAGE_MODEL_SETTING,
            choice: images,
          },
        ]}
      />
      <Problem text={error ?? images.error} />
      <KindPanel key={kind} project={project} kind={kind} model={images.model} />
    </>
  );
}
