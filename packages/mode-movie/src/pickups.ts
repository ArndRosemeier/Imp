import { defineCommand, requireProject, type Command, type KeyValueStore } from '@imp/core';
import { z } from 'zod';
import { editKey, movieSceneKey } from './commands.js';
import { commitCut, itemsOf, openCut, readCut, wholeShot, type Acting } from './edit.js';
import { MODE_ID, Scene, Shot, type CutItem, type Pickup, type SceneCut } from './schema.js';
import { readShots, requireShotSetting, shotKey, ShotFields } from './shots.js';

/**
 * Pickups: shots the edit asks for after the fact, such as a reaction to cut
 * away to or an insert that covers a jump. The request makes the shot in its
 * scene, written down for the Clip Designer, and puts it into the cut at once,
 * where it stands as a slate of its planned length until its clip is ready.
 * Then the clip takes its place by itself.
 */

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');

/** How far a pickup has come: asked for, being made, failed, or there. */
export const PickupStatus = z.enum(['requested', 'making', 'failed', 'ready']);
export type PickupStatus = z.infer<typeof PickupStatus>;

export const pickupStatus = (shot: Shot): PickupStatus => {
  if (shot.clip === null) return 'requested';
  if (shot.clip.status === 'pending') return 'making';
  return shot.clip.status === 'failed' ? 'failed' : 'ready';
};

/** A pickup as listed: the shot, why it was asked for, how far it is, and where it is cut in. */
export const PickupView = z.object({
  shotId: z.string(),
  sceneId: z.string(),
  scenePosition: z.number(),
  /** The shot's place in its scene, as the Shots screen numbers it. */
  shotPosition: z.number(),
  description: z.string(),
  reason: z.string(),
  seconds: z.number(),
  requestedBy: z.string(),
  requestedAt: z.string(),
  status: PickupStatus,
  /** The pieces of the cut it stands in, by scene and place counted from 1. */
  inCut: z.array(z.object({ sceneId: z.string(), itemId: z.string(), index: z.number() })),
});
export type PickupView = z.infer<typeof PickupView>;

const byOf = (actor: { kind: string; role?: string }): string =>
  actor.kind === 'agent' ? (actor.role ?? 'agent') : 'person';

async function scenesOf(store: KeyValueStore, projectId: string): Promise<Scene[]> {
  return (await store.list(movieSceneKey(projectId, '')))
    .map((entry) => Scene.parse(entry.value))
    .sort((a, b) => a.position - b.position);
}

/** Every pickup of the film, or of one scene, in film order, with where each is cut in. */
export async function listPickups(
  store: KeyValueStore,
  projectId: string,
  sceneId?: string,
): Promise<PickupView[]> {
  const scenes = await scenesOf(store, projectId);
  const cuts = new Map<string, readonly CutItem[]>();
  for (const scene of scenes) {
    const cut: SceneCut = await readCut(store, projectId, scene.id);
    cuts.set(scene.id, await itemsOf(store, projectId, cut));
  }
  const found: PickupView[] = [];
  for (const scene of scenes) {
    if (sceneId !== undefined && scene.id !== sceneId) continue;
    for (const shot of await readShots(store, projectId, scene.id)) {
      if (shot.pickup === null) continue;
      const inCut: PickupView['inCut'] = [];
      for (const [cutSceneId, items] of cuts) {
        items.forEach((item, index) => {
          if (item.kind === 'shot' && item.shotId === shot.id) {
            inCut.push({ sceneId: cutSceneId, itemId: item.id, index: index + 1 });
          }
        });
      }
      found.push({
        shotId: shot.id,
        sceneId: scene.id,
        scenePosition: scene.position,
        shotPosition: shot.position,
        description: shot.description,
        ...shot.pickup,
        status: pickupStatus(shot),
        inCut,
      });
    }
  }
  return found;
}

const RequestFields = ShotFields.pick({
  characterIds: true,
  performance: true,
  locationId: true,
  locationStateId: true,
  viewId: true,
  objects: true,
  speakerId: true,
  line: true,
  delivery: true,
}).partial();

/** Makes the shot of a pickup and puts it into the cut, for a person or an agent. */
async function requestPickup(
  at: Acting,
  input: z.infer<typeof RequestFields> & {
    projectId: string;
    sceneId: string;
    toIndex?: number | undefined;
    description: string;
    reason: string;
    seconds: number;
  },
): Promise<{ shot: Shot; item: CutItem }> {
  const id = 'movie.edit.pickup.request';
  const { runtime } = at;
  const { projectId, sceneId } = input;
  // The cut as it is before the shot exists, so that a cut that still follows
  // the shots does not take the new one in at its end as well.
  const { cut, items } = await openCut(at, id, projectId, sceneId);
  // The same for the scene's own cut while an agent's change waits as a
  // proposal: written out as it is seen, it keeps showing without the pickup.
  const own = await readCut(runtime.store, projectId, sceneId);
  if (own.items === null) {
    const seen = await itemsOf(runtime.store, projectId, own);
    await runtime.store.batch([
      { type: 'put', key: editKey(projectId, sceneId), value: { ...own, items: seen } },
    ]);
  }
  const shot: Shot = Shot.parse({
    id: runtime.newId(),
    sceneId,
    position: (await readShots(runtime.store, projectId, sceneId)).length + 1,
    description: input.description,
    characterIds: input.characterIds ?? [],
    performance: input.performance ?? '',
    locationId: input.locationId ?? null,
    locationStateId: input.locationStateId ?? null,
    viewId: input.viewId ?? null,
    objects: input.objects ?? [],
    speakerId: input.speakerId ?? null,
    line: input.line ?? '',
    delivery: input.delivery ?? '',
    // The length the cut asked for is the length the shot is planned to hold.
    lengthSeconds: input.seconds,
    lengthReason: input.reason,
    pickup: {
      reason: input.reason,
      seconds: input.seconds,
      requestedBy: byOf(at.actor),
      requestedAt: runtime.now().toISOString(),
    } satisfies Pickup,
  });
  await requireShotSetting(runtime.store, id, projectId, shot);
  await runtime.store.batch([
    { type: 'put', key: shotKey(projectId, sceneId, shot.id), value: shot },
  ]);
  const item: CutItem = { ...wholeShot(shot), id: runtime.newId() };
  const index = input.toIndex === undefined ? items.length : Math.min(input.toIndex, items.length);
  const before: SceneCut = { ...cut, items: [...items] };
  const after: SceneCut = {
    ...cut,
    items: [...items.slice(0, index), item, ...items.slice(index)],
  };
  await commitCut(at, projectId, before, after);
  return { shot, item };
}

export function createPickupCommands(): readonly Command[] {
  const request = defineCommand({
    id: 'movie.edit.pickup.request',
    title: 'Ask for a pickup shot',
    description:
      'Asks for a shot the cut needs and does not have, such as a reaction to cut away to, an insert of a hand or an object, or a cutaway that covers a jump. It makes the shot in the scene, described for the Clip Designer, and puts it into the cut at toIndex, where it stands as a slate of its planned length (seconds) until its clip is ready; then the clip takes its place. Say in reason what the cut needs it for, and describe the shot as fully as for movie.shot.create: framing, who is seen and what they do. Rescue the cut with what is there first; a pickup costs a clip. For an agent the placement in the cut is a proposal like other edits, the shot itself is made at once.',
    effect: 'write',
    input: RequestFields.extend({
      projectId: ProjectId,
      sceneId: SceneId,
      toIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Where in the cut it goes, counted from 0. Defaults to the end.'),
      description: z
        .string()
        .min(1)
        .max(2000)
        .describe('What the camera shows: framing, place, movement, light.'),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe('What the cut needs it for, such as "covers the jump in her answer".'),
      seconds: z
        .number()
        .min(0.5)
        .max(30)
        .default(3)
        .describe('How long it should run, which the slate holds until the clip arrives.'),
    }),
    output: z.object({ shot: Shot, item: z.object({ id: z.string() }) }),
    handler: async ({ runtime, actor }, input) => {
      const { shot, item } = await requestPickup({ runtime, actor }, input);
      return { shot, item: { id: item.id } };
    },
  });

  const list = defineCommand({
    id: 'movie.edit.pickup.list',
    title: 'List pickup shots',
    description:
      'Lists the pickup shots the edit asked for: what each shows, why the cut needs it, who asked, how far it is (requested, making, failed, ready) and where it stands in the cut. Leave sceneId out for the whole film; open: true lists only those without a ready clip. A pickup is made like any shot, with movie.shot.frame.generate and movie.shot.clip.generate.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId.optional(),
      open: z.boolean().optional().describe('Only pickups whose clip is not ready.'),
    }),
    output: z.object({ pickups: z.array(PickupView) }),
    handler: async ({ runtime }, { projectId, sceneId, open }) => {
      await requireProject(runtime.store, 'movie.edit.pickup.list', projectId, MODE_ID);
      const pickups = await listPickups(runtime.store, projectId, sceneId);
      return {
        pickups: open === true ? pickups.filter((pickup) => pickup.status !== 'ready') : pickups,
      };
    },
  });

  return [request, list];
}

/** The words on the slate a pickup stands as in the cut until its clip is ready. */
export function slateText(description: string): string {
  const words = description.trim().replace(/\s+/g, ' ');
  const short = words.length > 90 ? `${words.slice(0, 89).trimEnd()}…` : words;
  return short === '' ? 'Pickup shot to come' : `Pickup shot to come\n${short}`;
}
