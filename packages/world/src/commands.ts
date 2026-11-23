import {
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  type Command,
  type CoreRuntime,
  type BlobStore,
  type KeyValueStore,
  patchOf,
  chosenModel,
} from '@imp/core';
import { ProviderError, type GenerationProvider, type MediaInput } from '@imp/providers';
import { z } from 'zod';
import {
  keyImageOf,
  Location,
  State,
  View,
  WorldElement,
  WorldImage,
  WorldObject,
  type KeyImage,
  type WorldKind,
} from './schema.js';

/** The setting that names the model images are made with when a call does not say. */
export const IMAGE_MODEL_SETTING = 'images.model';

/** At most this many earlier pictures guide a new one; more confuse the models that take them. */
export const MAX_IMAGE_REFERENCES = 4;

export interface WorldCommandOptions {
  readonly provider: GenerationProvider;
  /**
   * The visual style of a project, which every picture of its world is made in.
   * The mode of the project knows where that is written (a film keeps it in its tone).
   */
  readonly style?: (store: KeyValueStore, projectId: string) => Promise<string>;
  /**
   * A picture that shows the look of a project, such as a film's chosen look
   * picture, which goes with every picture of a place where the model takes it.
   */
  readonly styleReference?: (
    store: KeyValueStore,
    blobs: BlobStore,
    projectId: string,
  ) => Promise<MediaInput | undefined>;
}

const ProjectId = z.string().describe('The id of a project from project.list.');

interface KindInfo {
  readonly plural: string;
  /** What the first view is called when the caller names none. */
  readonly firstView: string;
  readonly firstViewDescription: string;
  readonly aspectRatio: string;
}

const KINDS: Readonly<Record<WorldKind, KindInfo>> = {
  location: {
    plural: 'locations',
    firstView: 'Establishing',
    firstViewDescription: 'A wide view that shows the whole place and how it is laid out.',
    aspectRatio: '16:9',
  },
  object: {
    plural: 'objects',
    firstView: 'Front',
    firstViewDescription: 'The whole object from the front, at eye level.',
    aspectRatio: '1:1',
  },
};

/** Where the elements of one kind of a project are kept. Their pictures are under their key. */
export const worldPrefix = (projectId: string, kind?: WorldKind): string =>
  `${projectPrefix(projectId)}world/${kind === undefined ? '' : `${KINDS[kind].plural}/`}`;

const elementKey = (projectId: string, kind: WorldKind, id: string): string =>
  `${worldPrefix(projectId, kind)}${id}`;

/** Reads every element of one kind, sorted by name. */
export async function readWorld(
  store: KeyValueStore,
  projectId: string,
  kind: WorldKind,
): Promise<WorldElement[]> {
  return (await store.list(worldPrefix(projectId, kind)))
    .map((entry) => WorldElement.parse(entry.value))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads one element, or undefined when there is none of that kind under that id. */
export async function readElement(
  store: KeyValueStore,
  projectId: string,
  kind: WorldKind,
  id: string,
): Promise<WorldElement | undefined> {
  const stored = await store.get(elementKey(projectId, kind, id));
  if (stored === undefined) return undefined;
  const element = WorldElement.parse(stored);
  return element.kind === kind ? element : undefined;
}

async function load(
  store: KeyValueStore,
  commandId: string,
  projectId: string,
  kind: WorldKind,
  id: string,
): Promise<{ key: string; element: WorldElement }> {
  await requireProject(store, commandId, projectId);
  const element = await readElement(store, projectId, kind, id);
  if (element === undefined) {
    throw new CommandError('invalid_input', commandId, `No ${kind} "${id}".`);
  }
  return { key: elementKey(projectId, kind, id), element };
}

function findView(element: WorldElement, commandId: string, viewId: string): View {
  const view = element.views.find((candidate) => candidate.id === viewId);
  if (view === undefined) {
    throw new CommandError('invalid_input', commandId, `${element.name} has no view "${viewId}".`);
  }
  return view;
}

function findState(element: WorldElement, commandId: string, stateId: string): State {
  const state = element.states.find((candidate) => candidate.id === stateId);
  if (state === undefined) {
    throw new CommandError(
      'invalid_input',
      commandId,
      `${element.name} has no state "${stateId}".`,
    );
  }
  return state;
}

const sentence = (text: string): string => {
  const trimmed = text.trim();
  return trimmed === '' || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * What is sent to the image model for one view of an element in one state,
 * when the caller gives no prompt of their own. A place is drawn empty, so
 * that it can stand behind any scene; an object is drawn alone.
 */
export function worldImagePrompt(options: {
  readonly element: WorldElement;
  readonly view: View;
  readonly state: State | null;
  /** The place a location is part of, whose look it shares. */
  readonly parent?: Location | undefined;
  readonly style: string;
  readonly direction?: string | undefined;
  /** How many earlier pictures go with the prompt. */
  readonly references: number;
  /** Whether a picture of the project's look goes with the prompt too, after the others. */
  readonly styleReference?: boolean;
}): string {
  const { element, view, state, parent, style, direction, references } = options;
  const isPlace = element.kind === 'location';
  const opening = isPlace
    ? `Film location plate of ${element.name}, view "${view.name}".`
    : `Reference still of ${element.name}, view "${view.name}".`;
  return [
    opening,
    sentence(view.description),
    sentence(element.look === '' ? element.description : element.look),
    parent === undefined || parent.look === ''
      ? ''
      : `It is part of ${parent.name}: ${sentence(parent.look)}`,
    element.kind === 'location' && element.layout !== ''
      ? `Layout: ${sentence(element.layout)}`
      : '',
    state === null ? '' : `State "${state.name}": ${sentence(state.description)}`,
    references === 0
      ? ''
      : isPlace
        ? 'The reference images show this same place. Keep its architecture, materials, colours and the position of everything exactly as they are; only the camera position and the state described here may differ.'
        : 'The reference images show this same object. Keep its shape, proportions, materials and colours exactly; only the view and the state described here may differ.',
    style === '' ? '' : `Visual style: ${sentence(style)}`,
    options.styleReference === true
      ? 'The last reference image only shows the look of the film: take its colours, light and texture, not what is in it.'
      : '',
    sentence(direction ?? ''),
    isPlace
      ? 'No people in the frame.'
      : 'Alone on a plain neutral background, evenly lit, the whole object in frame.',
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * The pictures a new one is made to agree with, closest first: the same view
 * in its usual look (when a state is drawn), the master view in the same
 * state and in its usual look, then the other views.
 */
export function referencesFor(
  element: WorldElement,
  viewId: string,
  stateId: string | null,
): WorldImage[] {
  const exact = (view: string, state: string | null): WorldImage | undefined => {
    const key = element.keyImages.find(
      (candidate) => candidate.viewId === view && candidate.stateId === state,
    );
    return element.images.find((image) => image.id === key?.imageId);
  };
  const master = element.views[0]?.id ?? viewId;
  const candidates = [
    stateId === null ? undefined : exact(viewId, null),
    exact(master, stateId),
    exact(master, null),
    ...element.views.flatMap((view) => [
      stateId === null ? undefined : exact(view.id, stateId),
      exact(view.id, null),
    ]),
  ];
  const chosen: WorldImage[] = [];
  for (const image of candidates) {
    if (image === undefined || chosen.includes(image)) continue;
    // A picture never guides its own replacement.
    if (image.viewId === viewId && image.stateId === stateId) continue;
    chosen.push(image);
  }
  return chosen.slice(0, MAX_IMAGE_REFERENCES);
}

/** The images of an element without those matching `drop`, with key images that still exist. */
function withoutImages(
  element: WorldElement,
  drop: (image: WorldImage) => boolean,
): Pick<WorldElement, 'images' | 'keyImages'> & { dropped: WorldImage[] } {
  const dropped = element.images.filter(drop);
  const images = element.images.filter((image) => !drop(image));
  const keyImages: KeyImage[] = [];
  for (const key of element.keyImages) {
    if (images.some((image) => image.id === key.imageId)) {
      keyImages.push(key);
      continue;
    }
    // The newest remaining picture of that view and state takes the place of a removed one.
    const next = images.findLast(
      (image) => image.viewId === key.viewId && image.stateId === key.stateId,
    );
    if (next !== undefined) keyImages.push({ ...key, imageId: next.id });
  }
  return { images, keyImages, dropped };
}

async function deleteBlobs(runtime: CoreRuntime, images: readonly WorldImage[]): Promise<void> {
  for (const image of images) await runtime.blobs.delete(image.blobKey);
}

/** A short form of an element for lists: what it is called, its views and states, its picture. */
const Outline = z.object({
  id: z.string(),
  kind: z.enum(['location', 'object']),
  name: z.string(),
  parentId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  views: z.array(View.pick({ id: true, name: true })),
  states: z.array(State.pick({ id: true, name: true })),
  /** The key picture of the master view, or null before one was made. */
  imageKey: z.string().nullable(),
});

function outline(element: WorldElement): z.infer<typeof Outline> {
  return {
    id: element.id,
    kind: element.kind,
    name: element.name,
    ...(element.kind === 'location'
      ? { parentId: element.parentId }
      : { ownerId: element.ownerId }),
    views: element.views.map(({ id, name }) => ({ id, name })),
    states: element.states.map(({ id, name }) => ({ id, name })),
    imageKey: keyImageOf(element)?.blobKey ?? null,
  };
}

/** The commands that every kind has, under `world.<kind>.`. */
function kindCommands(
  kind: WorldKind,
  idKey: 'locationId' | 'objectId',
  options: WorldCommandOptions,
): Command[] {
  const info = KINDS[kind];
  const prefix = `world.${kind}`;
  // The id field is named after the kind ("locationId"), which agents read more easily than
  // a bare "id". TypeScript cannot follow a key chosen at run time through the schema, so the
  // schema is typed without it and the id is read by its name.
  const At = z.object({
    projectId: ProjectId,
    [idKey]: z.string().describe(`The id of a ${kind} from ${prefix}.list.`),
  }) as unknown as z.ZodObject<{ projectId: z.ZodString }>;
  const idOf = (input: object): string => (input as Record<string, string>)[idKey] ?? '';
  const save = async (runtime: CoreRuntime, key: string, element: WorldElement) => {
    await runtime.store.batch([{ type: 'put', key, value: element }]);
    return element;
  };

  const list = defineCommand({
    id: `${prefix}.list`,
    title: `List ${info.plural}`,
    description: `Returns the ${info.plural} of a project: id, name, the names of its views and states, and the key of its main picture. Details come from ${prefix}.get.`,
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      full: z
        .boolean()
        .default(false)
        .describe('Return every field of every one. Costly; prefer fetching single ones.'),
    }),
    output: z.object({ items: z.array(z.union([WorldElement, Outline])) }),
    handler: async ({ runtime }, { projectId, full }) => {
      await requireProject(runtime.store, `${prefix}.list`, projectId);
      const items = await readWorld(runtime.store, projectId, kind);
      return { items: full ? items : items.map(outline) };
    },
  });

  const get = defineCommand({
    id: `${prefix}.get`,
    title: `Read ${kind}`,
    description: `Returns one ${kind} with its look, views, states and pictures.`,
    effect: 'read',
    input: At,
    output: WorldElement,
    handler: async ({ runtime }, input) =>
      (await load(runtime.store, `${prefix}.get`, input.projectId, kind, idOf(input))).element,
  });

  const remove = defineCommand({
    id: `${prefix}.delete`,
    title: `Delete ${kind}`,
    description: `Removes a ${kind} with all its views, states and pictures. Scenes and shots that showed it show nothing in its place.`,
    effect: 'destructive',
    input: At,
    output: z.object({ id: z.string() }),
    handler: async ({ runtime }, input) => {
      const id = idOf(input);
      const { key, element } = await load(
        runtime.store,
        `${prefix}.delete`,
        input.projectId,
        kind,
        id,
      );
      // Places inside a removed place stand on their own afterwards.
      const children =
        kind === 'location'
          ? (await readWorld(runtime.store, input.projectId, 'location')).filter(
              (candidate) => candidate.kind === 'location' && candidate.parentId === id,
            )
          : [];
      await runtime.store.batch([
        { type: 'delete', key },
        ...children.map((child) => ({
          type: 'put' as const,
          key: elementKey(input.projectId, 'location', child.id),
          value: { ...child, parentId: null },
        })),
      ]);
      await deleteBlobs(runtime, element.images);
      return { id };
    },
  });

  const viewAdd = defineCommand({
    id: `${prefix}.view.add`,
    title: 'Add view',
    description: `Adds a named camera position to a ${kind}. Pictures of the new view are made to agree with the views that already have pictures, so scenes filmed from different angles show the same ${kind}.`,
    effect: 'write',
    input: At.extend({
      name: View.shape.name,
      description: View.shape.description.default(''),
    }),
    output: View,
    handler: async ({ runtime }, input) => {
      const { key, element } = await load(
        runtime.store,
        `${prefix}.view.add`,
        input.projectId,
        kind,
        idOf(input),
      );
      const view: View = { id: runtime.newId(), name: input.name, description: input.description };
      await save(runtime, key, { ...element, views: [...element.views, view] });
      return view;
    },
  });

  const viewUpdate = defineCommand({
    id: `${prefix}.view.update`,
    title: 'Change view',
    description:
      'Renames a view or changes its description. Pictures already made stay; make them again to see the change.',
    effect: 'write',
    input: At.extend({
      viewId: z.string(),
      name: View.shape.name.optional(),
      description: View.shape.description.optional(),
    }),
    output: View,
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.view.update`;
      const { key, element } = await load(runtime.store, id, input.projectId, kind, idOf(input));
      const current = findView(element, id, input.viewId);
      const view: View = {
        ...current,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
      };
      await save(runtime, key, {
        ...element,
        views: element.views.map((candidate) => (candidate.id === view.id ? view : candidate)),
      });
      return view;
    },
  });

  const viewRemove = defineCommand({
    id: `${prefix}.view.remove`,
    title: 'Remove view',
    description:
      'Removes a view and its pictures. The last view cannot be removed. When the first view goes, the next becomes the master the others agree with.',
    effect: 'destructive',
    input: At.extend({ viewId: z.string() }),
    output: z.object({ views: z.number() }),
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.view.remove`;
      const { key, element } = await load(runtime.store, id, input.projectId, kind, idOf(input));
      findView(element, id, input.viewId);
      if (element.views.length === 1) {
        throw new CommandError('invalid_input', id, 'The last view cannot be removed.');
      }
      const { dropped, ...pictures } = withoutImages(
        element,
        (image) => image.viewId === input.viewId,
      );
      const views = element.views.filter((view) => view.id !== input.viewId);
      await save(runtime, key, { ...element, ...pictures, views });
      await deleteBlobs(runtime, dropped);
      return { views: views.length };
    },
  });

  const stateAdd = defineCommand({
    id: `${prefix}.state.add`,
    title: 'Add state',
    description: `Adds a way the ${kind} can be at some point in the story, such as "Night, storm" or "Burned out". Scenes and shots say which state they show, and pictures can be made of each view in each state.`,
    effect: 'write',
    input: At.extend({
      name: State.shape.name,
      description: State.shape.description.default(''),
    }),
    output: State,
    handler: async ({ runtime }, input) => {
      const { key, element } = await load(
        runtime.store,
        `${prefix}.state.add`,
        input.projectId,
        kind,
        idOf(input),
      );
      const state: State = {
        id: runtime.newId(),
        name: input.name,
        description: input.description,
      };
      await save(runtime, key, { ...element, states: [...element.states, state] });
      return state;
    },
  });

  const stateUpdate = defineCommand({
    id: `${prefix}.state.update`,
    title: 'Change state',
    description: 'Renames a state or changes what differs in it.',
    effect: 'write',
    input: At.extend({
      stateId: z.string(),
      name: State.shape.name.optional(),
      description: State.shape.description.optional(),
    }),
    output: State,
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.state.update`;
      const { key, element } = await load(runtime.store, id, input.projectId, kind, idOf(input));
      const current = findState(element, id, input.stateId);
      const state: State = {
        ...current,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
      };
      await save(runtime, key, {
        ...element,
        states: element.states.map((candidate) => (candidate.id === state.id ? state : candidate)),
      });
      return state;
    },
  });

  const stateRemove = defineCommand({
    id: `${prefix}.state.remove`,
    title: 'Remove state',
    description:
      'Removes a state and the pictures made of it. Scenes and shots that showed it fall back to the usual look.',
    effect: 'destructive',
    input: At.extend({ stateId: z.string() }),
    output: z.object({ states: z.number() }),
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.state.remove`;
      const { key, element } = await load(runtime.store, id, input.projectId, kind, idOf(input));
      findState(element, id, input.stateId);
      const { dropped, ...pictures } = withoutImages(
        element,
        (image) => image.stateId === input.stateId,
      );
      const states = element.states.filter((state) => state.id !== input.stateId);
      await save(runtime, key, { ...element, ...pictures, states });
      await deleteBlobs(runtime, dropped);
      return { states: states.length };
    },
  });

  const imageGenerate = defineCommand({
    id: `${prefix}.image.generate`,
    title: 'Generate picture',
    description: `Makes a picture of one view of a ${kind} in one state, from its look${kind === 'location' ? ', layout' : ''}, the view, the state and the style of the project, and adds it. ${kind === 'location' ? 'Places are drawn empty, so they can stand behind any scene.' : 'Objects are drawn alone on a plain background.'} The pictures already made of other views and states go with it as references where the model takes them, so all pictures agree (the result says how many were used); make the master view first. The first picture of a view and state becomes its key picture, which guides video clips. Costs money at the image model.`,
    effect: 'spend',
    input: At.extend({
      viewId: z.string().optional().describe('The view to draw. Defaults to the first view.'),
      stateId: z
        .string()
        .nullable()
        .default(null)
        .describe('The state to draw, or null for the usual look.'),
      direction: z
        .string()
        .optional()
        .describe('What should differ in this picture, for example "warmer light, less clutter".'),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe('The whole prompt, replacing the one built from the look. Rarely needed.'),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `An image model id from models.list. Defaults to the setting "${IMAGE_MODEL_SETTING}".`,
        ),
      aspectRatio: z
        .string()
        .regex(/^\d+:\d+$/)
        .default(info.aspectRatio),
      references: z
        .boolean()
        .default(true)
        .describe('Send the pictures already made as references. Switch off to start afresh.'),
    }),
    output: z.object({ image: WorldImage }),
    estimate: async ({ runtime }, input) => ({
      kind: 'image',
      model: await chosenModel(runtime.store, IMAGE_MODEL_SETTING, input.model),
    }),
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.image.generate`;
      const elementId = idOf(input);
      const { key, element } = await load(runtime.store, id, input.projectId, kind, elementId);
      const view = findView(element, id, input.viewId ?? element.views[0]?.id ?? '');
      const state = input.stateId === null ? null : findState(element, id, input.stateId);
      const model = input.model ?? (await runtime.store.get(`settings/${IMAGE_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No image model is chosen. Set the setting "${IMAGE_MODEL_SETTING}" to an id from models.list with output "image", or pass a model.`,
        );
      }

      const references: MediaInput[] = [];
      if (input.references) {
        for (const image of referencesFor(element, view.id, state?.id ?? null)) {
          const blob = await runtime.blobs.get(image.blobKey);
          if (blob !== undefined) references.push(blob);
        }
      }
      const parent =
        element.kind === 'location' && element.parentId !== null
          ? await readElement(runtime.store, input.projectId, 'location', element.parentId)
          : undefined;
      const style = (await options.style?.(runtime.store, input.projectId)) ?? '';
      // A place is drawn in the look of the film too, after the pictures of itself.
      const look =
        element.kind === 'location' && references.length < MAX_IMAGE_REFERENCES
          ? await options.styleReference?.(runtime.store, runtime.blobs, input.projectId)
          : undefined;
      if (look !== undefined) references.push(look);
      const promptFor = (count: number): string =>
        input.prompt ??
        worldImagePrompt({
          element,
          view,
          state,
          parent: parent?.kind === 'location' ? parent : undefined,
          style,
          direction: input.direction,
          references: look !== undefined && count > 0 ? count - 1 : count,
          styleReference: look !== undefined && count > 0,
        });

      let used = references.length;
      let generated;
      try {
        const request = { model, aspectRatio: input.aspectRatio };
        try {
          generated = await options.provider.generateImage(
            used === 0
              ? { ...request, prompt: promptFor(0) }
              : { ...request, prompt: promptFor(used), references },
          );
        } catch (error) {
          // A model that takes no images refuses, which costs nothing: draw from the words alone.
          if (!(error instanceof ProviderError) || error.kind !== 'bad_request' || used === 0) {
            throw error;
          }
          used = 0;
          generated = await options.provider.generateImage({ ...request, prompt: promptFor(0) });
        }
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No picture was made: ${error.message}`, {
          cause: error,
        });
      }
      const [first] = generated.images;
      if (first === undefined) {
        throw new CommandError('handler_failed', id, 'The model returned no picture.');
      }
      const imageId = runtime.newId();
      const image: WorldImage = {
        id: imageId,
        blobKey: `${key}/images/${imageId}`,
        mediaType: first.mediaType,
        viewId: view.id,
        stateId: state?.id ?? null,
        prompt: promptFor(used),
        model,
        references: used,
        costUsd: generated.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(image.blobKey, { bytes: first.bytes, mediaType: first.mediaType });
      // Read again: drawing takes seconds, and the element may have changed meanwhile.
      const latest = (await load(runtime.store, id, input.projectId, kind, elementId)).element;
      const hasKey = latest.keyImages.some(
        (candidate) => candidate.viewId === image.viewId && candidate.stateId === image.stateId,
      );
      await save(runtime, key, {
        ...latest,
        images: [...latest.images, image],
        keyImages: hasKey
          ? latest.keyImages
          : [...latest.keyImages, { viewId: image.viewId, stateId: image.stateId, imageId }],
      });
      return { image };
    },
  });

  const imageSelect = defineCommand({
    id: `${prefix}.image.select`,
    title: 'Choose key picture',
    description:
      'Makes a picture the key picture of its view and state: the one that guides clips and the pictures of other views.',
    effect: 'write',
    input: At.extend({ imageId: z.string() }),
    output: z.object({ viewId: z.string(), stateId: z.string().nullable(), imageId: z.string() }),
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.image.select`;
      const { key, element } = await load(runtime.store, id, input.projectId, kind, idOf(input));
      const image = element.images.find((candidate) => candidate.id === input.imageId);
      if (image === undefined) {
        throw new CommandError('invalid_input', id, `No picture "${input.imageId}".`);
      }
      const chosen = { viewId: image.viewId, stateId: image.stateId, imageId: image.id };
      await save(runtime, key, {
        ...element,
        keyImages: [
          ...element.keyImages.filter(
            (candidate) => candidate.viewId !== image.viewId || candidate.stateId !== image.stateId,
          ),
          chosen,
        ],
      });
      return chosen;
    },
  });

  const imageDelete = defineCommand({
    id: `${prefix}.image.delete`,
    title: 'Delete picture',
    description:
      'Removes one picture. If it was a key picture, the newest remaining picture of the same view and state takes its place.',
    effect: 'destructive',
    input: At.extend({ imageId: z.string() }),
    output: z.object({ images: z.number() }),
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.image.delete`;
      const { key, element } = await load(runtime.store, id, input.projectId, kind, idOf(input));
      if (!element.images.some((image) => image.id === input.imageId)) {
        throw new CommandError('invalid_input', id, `No picture "${input.imageId}".`);
      }
      const { dropped, ...pictures } = withoutImages(
        element,
        (image) => image.id === input.imageId,
      );
      await save(runtime, key, { ...element, ...pictures });
      await deleteBlobs(runtime, dropped);
      return { images: pictures.images.length };
    },
  });

  const imageFromFile = defineCommand({
    id: `${prefix}.image.fromFile`,
    title: 'Use a picture',
    description: `Adds a stored picture as a picture of one view of a ${kind} in one state: a photo or drawing imported into the library, or a picture from another project. With choose true (the default) it becomes the key picture of that view and state, which guides clips and the pictures of other views. Costs nothing.`,
    effect: 'write',
    input: At.extend({
      blobKey: z
        .string()
        .min(1)
        .describe('The stored picture, for example the blobKey of a library asset.'),
      viewId: z.string().optional().describe('The view it shows. Defaults to the first view.'),
      stateId: z
        .string()
        .nullable()
        .default(null)
        .describe('The state it shows, or null for the usual look.'),
      choose: z.boolean().default(true),
    }),
    output: z.object({ image: WorldImage }),
    handler: async ({ runtime }, input) => {
      const id = `${prefix}.image.fromFile`;
      const elementId = idOf(input);
      const { key, element } = await load(runtime.store, id, input.projectId, kind, elementId);
      const view = findView(element, id, input.viewId ?? element.views[0]?.id ?? '');
      const state = input.stateId === null ? null : findState(element, id, input.stateId);
      const blob = await runtime.blobs.get(input.blobKey);
      if (blob === undefined) {
        throw new CommandError('invalid_input', id, `Nothing is stored under "${input.blobKey}".`);
      }
      if (!blob.mediaType.startsWith('image/')) {
        throw new CommandError('invalid_input', id, 'That file is not a picture.');
      }
      const imageId = runtime.newId();
      const image: WorldImage = {
        id: imageId,
        blobKey: `${key}/images/${imageId}`,
        mediaType: blob.mediaType,
        viewId: view.id,
        stateId: state?.id ?? null,
        prompt: '',
        model: 'file',
        references: 0,
        costUsd: null,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(image.blobKey, blob);
      const latest = (await load(runtime.store, id, input.projectId, kind, elementId)).element;
      const others = latest.keyImages.filter(
        (candidate) => candidate.viewId !== image.viewId || candidate.stateId !== image.stateId,
      );
      const hasKey = others.length !== latest.keyImages.length;
      await save(runtime, key, {
        ...latest,
        images: [...latest.images, image],
        keyImages:
          input.choose || !hasKey
            ? [...others, { viewId: image.viewId, stateId: image.stateId, imageId }]
            : latest.keyImages,
      });
      return { image };
    },
  });

  return [
    list,
    get,
    remove,
    viewAdd,
    viewUpdate,
    viewRemove,
    stateAdd,
    stateUpdate,
    stateRemove,
    imageGenerate,
    imageSelect,
    imageDelete,
    imageFromFile,
  ];
}

const FirstView = {
  firstView: View.shape.name
    .optional()
    .describe('The name of the first view, the master the others agree with.'),
  firstViewDescription: View.shape.description.optional(),
};

async function requireParent(
  store: KeyValueStore,
  commandId: string,
  projectId: string,
  locationId: string,
  parentId: string | null,
): Promise<void> {
  // Walk up from the new parent: meeting the location itself would make a circle.
  let current = parentId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === locationId) {
      throw new CommandError(
        'invalid_input',
        commandId,
        'A location cannot be part of itself or of a place inside it.',
      );
    }
    if (seen.has(current)) return;
    seen.add(current);
    const parent = await readElement(store, projectId, 'location', current);
    if (parent?.kind !== 'location') {
      throw new CommandError('invalid_input', commandId, `No location "${current}".`);
    }
    current = parent.parentId;
  }
}

const LocationFields = Location.pick({
  name: true,
  description: true,
  look: true,
  layout: true,
  ambience: true,
  parentId: true,
});

const ObjectFields = WorldObject.pick({ name: true, description: true, look: true, ownerId: true });

function firstViewOf(
  runtime: CoreRuntime,
  kind: WorldKind,
  input: { firstView?: string | undefined; firstViewDescription?: string | undefined },
): View {
  return {
    id: runtime.newId(),
    name: input.firstView ?? KINDS[kind].firstView,
    description:
      input.firstViewDescription ??
      (input.firstView === undefined ? KINDS[kind].firstViewDescription : ''),
  };
}

/**
 * The commands of the world: locations and objects with their views, states
 * and pictures. They work in a project of any mode.
 */
export function createWorldCommands(options: WorldCommandOptions): readonly Command[] {
  const locationCreate = defineCommand({
    id: 'world.location.create',
    title: 'Add location',
    description:
      'Adds a place to the world of a project, with a first view. Write the look and the layout precisely: they are what every picture and clip of the place is made from.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      name: LocationFields.shape.name,
      description: LocationFields.shape.description.default(''),
      look: LocationFields.shape.look.default(''),
      layout: LocationFields.shape.layout.default(''),
      ambience: LocationFields.shape.ambience.default(''),
      parentId: LocationFields.shape.parentId.default(null),
      ...FirstView,
    }),
    output: Location,
    handler: async ({ runtime }, { projectId, firstView, firstViewDescription, ...fields }) => {
      const id = 'world.location.create';
      await requireProject(runtime.store, id, projectId);
      const locationId = runtime.newId();
      await requireParent(runtime.store, id, projectId, locationId, fields.parentId);
      const location: Location = {
        id: locationId,
        kind: 'location',
        ...fields,
        views: [firstViewOf(runtime, 'location', { firstView, firstViewDescription })],
        states: [],
        images: [],
        keyImages: [],
        createdAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: elementKey(projectId, 'location', locationId), value: location },
      ]);
      return location;
    },
  });

  const locationUpdate = defineCommand({
    id: 'world.location.update',
    title: 'Change location',
    description:
      'Changes the name, description, look, layout, ambience or the place it is part of. Fields left out stay as they are. Pictures already made stay; make them again to see the change.',
    effect: 'write',
    input: patchOf(LocationFields).extend({ projectId: ProjectId, locationId: z.string() }),
    output: Location,
    handler: async ({ runtime }, { projectId, locationId, ...changes }) => {
      const id = 'world.location.update';
      const { key, element } = await load(runtime.store, id, projectId, 'location', locationId);
      if (element.kind !== 'location') throw new CommandError('invalid_input', id, 'Not a place.');
      if (changes.parentId !== undefined) {
        await requireParent(runtime.store, id, projectId, locationId, changes.parentId);
      }
      const next: Location = {
        ...element,
        name: changes.name ?? element.name,
        description: changes.description ?? element.description,
        look: changes.look ?? element.look,
        layout: changes.layout ?? element.layout,
        ambience: changes.ambience ?? element.ambience,
        parentId: changes.parentId === undefined ? element.parentId : changes.parentId,
      };
      await runtime.store.batch([{ type: 'put', key, value: next }]);
      return next;
    },
  });

  const objectCreate = defineCommand({
    id: 'world.object.create',
    title: 'Add object',
    description:
      'Adds an object (a prop) to the world of a project, with a first view. Write the look precisely: it is what every picture and clip of the object is made from.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      name: ObjectFields.shape.name,
      description: ObjectFields.shape.description.default(''),
      look: ObjectFields.shape.look.default(''),
      ownerId: ObjectFields.shape.ownerId.default(null),
      ...FirstView,
    }),
    output: WorldObject,
    handler: async ({ runtime }, { projectId, firstView, firstViewDescription, ...fields }) => {
      await requireProject(runtime.store, 'world.object.create', projectId);
      const object: WorldObject = {
        id: runtime.newId(),
        kind: 'object',
        ...fields,
        views: [firstViewOf(runtime, 'object', { firstView, firstViewDescription })],
        states: [],
        images: [],
        keyImages: [],
        createdAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: elementKey(projectId, 'object', object.id), value: object },
      ]);
      return object;
    },
  });

  const objectUpdate = defineCommand({
    id: 'world.object.update',
    title: 'Change object',
    description:
      'Changes the name, description, look or owner of an object. Fields left out stay as they are.',
    effect: 'write',
    input: patchOf(ObjectFields).extend({ projectId: ProjectId, objectId: z.string() }),
    output: WorldObject,
    handler: async ({ runtime }, { projectId, objectId, ...changes }) => {
      const id = 'world.object.update';
      const { key, element } = await load(runtime.store, id, projectId, 'object', objectId);
      if (element.kind !== 'object') throw new CommandError('invalid_input', id, 'Not an object.');
      const next: WorldObject = {
        ...element,
        name: changes.name ?? element.name,
        description: changes.description ?? element.description,
        look: changes.look ?? element.look,
        ownerId: changes.ownerId === undefined ? element.ownerId : changes.ownerId,
      };
      await runtime.store.batch([{ type: 'put', key, value: next }]);
      return next;
    },
  });

  return [
    locationCreate,
    locationUpdate,
    ...kindCommands('location', 'locationId', options),
    objectCreate,
    objectUpdate,
    ...kindCommands('object', 'objectId', options),
  ];
}
