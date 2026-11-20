import { z } from 'zod';

/**
 * The world of a project: the places and the objects its story happens in and
 * with. It belongs to no mode, because a film, a comic or a game needs the
 * same lamp room and the same pocket watch in every picture they appear in.
 */
export const WorldKind = z.enum(['location', 'object']);
export type WorldKind = z.infer<typeof WorldKind>;

/**
 * A named camera position: where the camera stands and what it looks at. A
 * place filmed from several sides needs a picture of each side, made to agree
 * with the others, so that scenes shot from different angles show one place.
 */
export const View = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1)
    .max(60)
    .describe('A short name for the camera position, for example "From the stairs".'),
  description: z
    .string()
    .max(1000)
    .describe(
      'Where the camera stands, what it looks at and what is in frame, for example "low in the stairwell door, looking up at the lamp; the sea window on the right".',
    ),
});
export type View = z.infer<typeof View>;

/**
 * A way the place or object can be at some point in the story: night and day,
 * before and after the fire, whole and cracked. A state adds to the look.
 */
export const State = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1)
    .max(60)
    .describe('A short name, for example "Night, storm" or "Cracked".'),
  description: z
    .string()
    .max(1000)
    .describe(
      'What differs from the usual look, for example "rain lashing the windows, only the lamp lights the room".',
    ),
});
export type State = z.infer<typeof State>;

/** A generated picture of one view in one state. The bytes are in the blob store. */
export const WorldImage = z.object({
  id: z.string(),
  blobKey: z.string(),
  mediaType: z.string(),
  viewId: z.string(),
  /** The state shown, or null for the usual look. */
  stateId: z.string().nullable(),
  /** The prompt and model it was made with, so it can be made again or varied. */
  prompt: z.string(),
  model: z.string(),
  /** How many earlier pictures it was made to agree with. Zero when the model took none. */
  references: z.number().int().min(0),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type WorldImage = z.infer<typeof WorldImage>;

/** The picture that stands for one view in one state. */
export const KeyImage = z.object({
  viewId: z.string(),
  stateId: z.string().nullable(),
  imageId: z.string(),
});
export type KeyImage = z.infer<typeof KeyImage>;

const Name = z.string().min(1).max(80);
const Description = z.string().describe('What it is and what it means in the story.');
const Look = z
  .string()
  .describe(
    'How it looks, precise enough that an image model draws the same thing every time: shapes, materials, colours, wear, light.',
  );

const shared = {
  id: z.string(),
  name: Name,
  description: Description,
  look: Look,
  /** The first view is the master: every other view is made to agree with it. */
  views: z.array(View).min(1),
  states: z.array(State).default([]),
  images: z.array(WorldImage).default([]),
  keyImages: z.array(KeyImage).default([]),
  createdAt: z.iso.datetime(),
};

export const Location = z.object({
  ...shared,
  kind: z.literal('location'),
  layout: z
    .string()
    .describe(
      'Where things are in the place, relative to each other: "the door is opposite the sea window, the iron stairs come up in the middle, the lamp sits on a plinth above them". It keeps the views in agreement.',
    ),
  ambience: z
    .string()
    .describe('What the place sounds like, for example "wind in the iron frame, distant surf".'),
  parentId: z
    .string()
    .nullable()
    .describe('The location this one is part of, for example the lighthouse for the lamp room.'),
});
export type Location = z.infer<typeof Location>;

export const WorldObject = z.object({
  ...shared,
  kind: z.literal('object'),
  ownerId: z
    .string()
    .nullable()
    .describe('Who or what it belongs to: the id of a character or a location, or null.'),
});
export type WorldObject = z.infer<typeof WorldObject>;

export const WorldElement = z.discriminatedUnion('kind', [Location, WorldObject]);
export type WorldElement = Location | WorldObject;

/**
 * The picture that best shows a view in a state. When that exact one was not
 * made, it falls back to the same view in its usual look, then to the master
 * view, so a shot always gets the closest picture there is.
 */
export function keyImageOf(
  element: WorldElement,
  viewId: string | null = null,
  stateId: string | null = null,
): WorldImage | undefined {
  const master = element.views[0]?.id;
  const view =
    viewId !== null && element.views.some((candidate) => candidate.id === viewId) ? viewId : master;
  const state = element.states.some((candidate) => candidate.id === stateId) ? stateId : null;
  const tries: [string | undefined, string | null][] = [
    [view, state],
    [view, null],
    [master, state],
    [master, null],
  ];
  for (const [tryView, tryState] of tries) {
    const key = element.keyImages.find(
      (candidate) => candidate.viewId === tryView && candidate.stateId === tryState,
    );
    const image = element.images.find((candidate) => candidate.id === key?.imageId);
    if (image !== undefined) return image;
  }
  return undefined;
}
