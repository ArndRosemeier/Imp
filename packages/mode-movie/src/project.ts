import {
  CommandError,
  createRewriter,
  freeName,
  itemKey,
  projectPrefix,
  type CollisionChoice,
  type CopyOutcome,
  type CoreRuntime,
  type GuidedPath,
  type JsonValue,
  type KeyValueStore,
  type PlannedItem,
  type ProjectSummary,
  type ProjectSupport,
  type ResourceCopier,
  type ResourceItem,
  type WriteOperation,
} from '@imp/core';
import { keyImageOf, readWorld, worldPrefix, type WorldElement, type WorldKind } from '@imp/world';
import {
  characterPrefix,
  editKey,
  movieDevelopmentKey,
  movieSceneKey,
  shotPrefix,
  soundPrefix,
} from './commands.js';
import {
  Character,
  Development,
  EMPTY_DEVELOPMENT,
  Scene,
  SceneCut,
  Shot,
  Sound,
} from './schema.js';
import { movieTemplates } from './templates.js';

/** The parts of a movie project that copying and the start screen look at. */
interface Movie {
  readonly development: Development;
  readonly scenes: Scene[];
  readonly characters: Character[];
  readonly locations: WorldElement[];
  readonly objects: WorldElement[];
  /** By scene id. */
  readonly shots: Map<string, Shot[]>;
  readonly sounds: Map<string, Sound[]>;
  readonly cuts: Map<string, SceneCut>;
}

function grouped<T extends { sceneId: string }>(values: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) map.set(value.sceneId, [...(map.get(value.sceneId) ?? []), value]);
  return map;
}

async function readMovie(store: KeyValueStore, projectId: string): Promise<Movie> {
  const stored = await store.get(movieDevelopmentKey(projectId));
  const scenes = (await store.list(movieSceneKey(projectId, '')))
    .map((entry) => Scene.parse(entry.value))
    .sort((a, b) => a.position - b.position);
  const characters = (await store.list(characterPrefix(projectId)))
    .map((entry) => Character.parse(entry.value))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shots = (await store.list(shotPrefix(projectId)))
    .map((entry) => Shot.parse(entry.value))
    .sort((a, b) => a.position - b.position);
  const sounds = (await store.list(soundPrefix(projectId)))
    .map((entry) => Sound.parse(entry.value))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const cuts = new Map<string, SceneCut>();
  for (const scene of scenes) {
    const cut = await store.get(editKey(projectId, scene.id));
    if (cut !== undefined) cuts.set(scene.id, SceneCut.parse(cut));
  }
  return {
    development: stored === undefined ? EMPTY_DEVELOPMENT : Development.parse(stored),
    scenes,
    characters,
    locations: await readWorld(store, projectId, 'location'),
    objects: await readWorld(store, projectId, 'object'),
    shots: grouped(shots),
    sounds: grouped(sounds),
    cuts,
  };
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** How far a movie has come, stage by stage. */
export async function summarizeMovie(
  runtime: CoreRuntime,
  projectId: string,
): Promise<ProjectSummary> {
  const movie = await readMovie(runtime.store, projectId);
  const { development, scenes, characters } = movie;
  const shots = [...movie.shots.values()].flat();
  const sounds = [...movie.sounds.values()].flat();
  const filled = Object.values(development).filter((text) => text.trim() !== '').length;
  const written = scenes.filter((scene) => scene.body.trim() !== '').length;
  const portrayed = characters.filter((character) => character.portraitId !== null).length;
  // A voice-only character, such as a narrator, is cast once it has a voice.
  const cast = characters.filter((character) =>
    character.voiceOnly ? character.voiceSample !== null : character.portraitId !== null,
  ).length;
  const voiced = characters.filter((character) => character.voiceSample !== null).length;
  const world = [...movie.locations, ...movie.objects];
  const drawn = world.filter((element) => keyImageOf(element) !== undefined).length;
  const ready = shots.filter((shot) => shot.clip?.status === 'ready').length;
  const made = sounds.filter((sound) => sound.take !== null).length;
  const cut = scenes.filter((scene) => {
    const sceneCut = movie.cuts.get(scene.id);
    return sceneCut !== undefined && (sceneCut.items !== null || sceneCut.sounds.length > 0);
  }).length;
  const firstLine = (text: string): string => text.trim().split(/\n/)[0] ?? '';
  const posterKeys = characters.flatMap((character) => {
    const portrait = character.images.find((image) => image.id === character.portraitId);
    return portrait === undefined ? [] : [portrait.blobKey];
  });
  return {
    headline: firstLine(development.logline) || firstLine(development.premise),
    posterKeys: posterKeys.slice(0, 4),
    stages: [
      {
        id: 'development',
        name: 'Development',
        done: filled,
        total: 4,
        note: filled === 0 ? 'Not started' : `${String(filled)} of 4 parts written`,
      },
      {
        id: 'script',
        name: 'Script',
        done: written,
        total: scenes.length,
        note:
          scenes.length === 0
            ? 'No scenes'
            : `${String(written)} of ${plural(scenes.length, 'scene')} written`,
      },
      {
        id: 'casting',
        name: 'Casting',
        done: cast,
        total: characters.length,
        note:
          characters.length === 0
            ? 'No characters'
            : `${plural(characters.length, 'character')}, ${String(portrayed)} with a portrait, ${String(voiced)} with a voice`,
      },
      {
        id: 'design',
        name: 'Design',
        done: drawn,
        total: world.length,
        note:
          world.length === 0
            ? 'No locations or objects'
            : `${plural(movie.locations.length, 'location')}, ${plural(movie.objects.length, 'object')}, ${String(drawn)} drawn`,
      },
      {
        id: 'shots',
        name: 'Shots',
        done: ready,
        total: shots.length,
        note:
          shots.length === 0
            ? 'No shots'
            : `${String(ready)} of ${plural(shots.length, 'clip')} ready`,
      },
      {
        id: 'sound',
        name: 'Sound',
        done: made,
        total: sounds.length,
        note:
          sounds.length === 0
            ? 'No sounds'
            : `${String(made)} of ${plural(sounds.length, 'sound')} made`,
      },
      {
        id: 'edit',
        name: 'Edit',
        done: cut,
        total: scenes.length,
        note:
          scenes.length === 0
            ? 'Nothing to cut'
            : `${String(cut)} of ${plural(scenes.length, 'scene')} cut`,
      },
    ],
  };
}

// Copying between projects

const DEVELOPMENT_ID = 'development';
const ALL: CollisionChoice[] = ['overwrite', 'keepBoth', 'skip'];
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const excerpt = (text: string, length = 90): string => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};
const sceneName = (scene: Scene): string =>
  `${String(scene.position)}. ${scene.heading.trim() === '' ? 'Untitled scene' : scene.heading}`;

/** The characters a shot shows or lets speak. */
const castOf = (shot: Shot): string[] => [
  ...new Set([...shot.characterIds, ...(shot.speakerId === null ? [] : [shot.speakerId])]),
];

/** The other scenes a cut takes pictures or sound from. */
function scenesUsedBy(cut: SceneCut | undefined, sceneId: string): string[] {
  if (cut === undefined) return [];
  const used = [
    ...(cut.items ?? []).filter((item) => item.kind === 'shot').map((item) => item.sceneId),
    ...cut.sounds.filter((sound) => sound.source !== 'sound').map((sound) => sound.sceneId),
  ];
  return [...new Set(used)].filter((id) => id !== '' && id !== sceneId);
}

const KIND_OF: Readonly<Record<string, WorldKind>> = { location: 'location', object: 'object' };
const elementsOf = (movie: Movie, kind: WorldKind): WorldElement[] =>
  kind === 'location' ? movie.locations : movie.objects;
const elementKey = (projectId: string, kind: WorldKind, id: string): string =>
  `${worldPrefix(projectId, kind)}${id}`;

/** The places and objects a scene or a shot needs, as copy kinds and ids. */
function worldOf(scene: Scene | undefined, shots: readonly Shot[]): [WorldKind, string][] {
  const needs: [WorldKind, string][] = [];
  if (scene !== undefined && scene.locationId !== null) needs.push(['location', scene.locationId]);
  for (const shot of shots) {
    if (shot.locationId !== null) needs.push(['location', shot.locationId]);
    for (const seen of shot.objects) needs.push(['object', seen.objectId]);
  }
  return needs;
}

function findShot(movie: Movie, shotId: string): Shot | undefined {
  return [...movie.shots.values()].flat().find((shot) => shot.id === shotId);
}
function findSound(movie: Movie, soundId: string): Sound | undefined {
  return [...movie.sounds.values()].flat().find((sound) => sound.id === soundId);
}

async function moveFiles(
  runtime: CoreRuntime,
  fromPrefix: string,
  rewrite: (key: string) => string,
): Promise<void> {
  for (const key of await runtime.blobs.list(fromPrefix)) {
    const blob = await runtime.blobs.get(key);
    if (blob !== undefined) await runtime.blobs.put(rewrite(key), blob);
  }
}

async function removeFiles(runtime: CoreRuntime, prefix: string): Promise<void> {
  for (const key of await runtime.blobs.list(prefix)) await runtime.blobs.delete(key);
}

export const movieCopier: ResourceCopier = {
  kinds: [
    {
      id: 'development',
      label: 'Development notes',
      plural: 'Development notes',
      needsParent: false,
      parentKind: null,
    },
    {
      id: 'character',
      label: 'Character',
      plural: 'Characters',
      needsParent: false,
      parentKind: null,
    },
    {
      id: 'location',
      label: 'Location',
      plural: 'Locations',
      needsParent: false,
      parentKind: null,
    },
    { id: 'object', label: 'Object', plural: 'Objects', needsParent: false, parentKind: null },
    { id: 'scene', label: 'Scene', plural: 'Scenes', needsParent: false, parentKind: null },
    { id: 'shot', label: 'Shot', plural: 'Shots', needsParent: true, parentKind: 'scene' },
    { id: 'sound', label: 'Sound', plural: 'Sounds', needsParent: true, parentKind: 'scene' },
  ],

  async list(runtime, projectId) {
    const movie = await readMovie(runtime.store, projectId);
    const items: ResourceItem[] = [];
    const { development } = movie;
    if (Object.values(development).some((text) => text.trim() !== '')) {
      items.push({
        kind: 'development',
        id: DEVELOPMENT_ID,
        name: 'Development notes',
        detail: excerpt(development.logline || development.premise || development.treatment),
        parentId: null,
      });
    }
    for (const character of movie.characters) {
      const has = [
        character.part,
        character.portraitId === null ? '' : 'portrait',
        character.voiceSample === null ? '' : 'voice',
      ].filter((part) => part !== '');
      items.push({
        kind: 'character',
        id: character.id,
        name: character.name,
        detail: has.join(' · '),
        parentId: null,
      });
    }
    for (const element of [...movie.locations, ...movie.objects]) {
      items.push({
        kind: element.kind,
        id: element.id,
        name: element.name,
        detail: [
          plural(element.views.length, 'view'),
          element.states.length === 0 ? '' : plural(element.states.length, 'state'),
          plural(element.images.length, 'picture'),
        ]
          .filter((part) => part !== '')
          .join(' · '),
        parentId: null,
      });
    }
    for (const scene of movie.scenes) {
      const shots = movie.shots.get(scene.id) ?? [];
      const sounds = movie.sounds.get(scene.id) ?? [];
      items.push({
        kind: 'scene',
        id: scene.id,
        name: sceneName(scene),
        detail: [
          excerpt(scene.summary, 70),
          plural(shots.length, 'shot'),
          plural(sounds.length, 'sound'),
        ]
          .filter((part) => part !== '')
          .join(' · '),
        parentId: null,
      });
      for (const shot of shots) {
        items.push({
          kind: 'shot',
          id: shot.id,
          name: `Scene ${String(scene.position)}, shot ${String(shot.position)}`,
          detail: [excerpt(shot.description, 70), shot.clip?.status === 'ready' ? 'clip' : '']
            .filter((part) => part !== '')
            .join(' · '),
          parentId: scene.id,
        });
      }
      for (const sound of sounds) {
        items.push({
          kind: 'sound',
          id: sound.id,
          name: sound.name,
          detail: `${sound.kind === 'music' ? 'Music' : 'Effect'} in scene ${String(scene.position)}${sound.take === null ? ' · not made yet' : ''}`,
          parentId: scene.id,
        });
      }
    }
    return items;
  },

  async plan(runtime, spec) {
    const source = await readMovie(runtime.store, spec.fromProjectId);
    const target = await readMovie(runtime.store, spec.toProjectId);
    const pickedScenes = new Set(spec.picks.filter((p) => p.kind === 'scene').map((p) => p.id));
    const planned: PlannedItem[] = [];
    const seen = new Set<string>();
    const queue: {
      kind: string;
      id: string;
      reason: 'picked' | 'needed';
      neededBy: string | null;
    }[] = spec.picks.map((pick) => ({ ...pick, reason: 'picked', neededBy: null }));
    const fail = (message: string): never => {
      throw new CommandError('invalid_input', 'project.resources.copy', message);
    };
    if (spec.parentId !== null && !target.scenes.some((scene) => scene.id === spec.parentId)) {
      fail(`The target has no scene "${spec.parentId}".`);
    }
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      const key = itemKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      const need = (kind: string, id: string, by: string): void => {
        queue.push({ kind, id, reason: 'needed', neededBy: by });
      };
      if (next.kind === 'development') {
        const filled = Object.values(target.development).some((text) => text.trim() !== '');
        planned.push({
          ...next,
          name: 'Development notes',
          collision: filled
            ? {
                targetId: DEVELOPMENT_ID,
                targetName: 'Development notes',
                match: 'singleton',
                choices: ['overwrite', 'skip'],
              }
            : null,
        });
      } else if (next.kind === 'character') {
        const character = source.characters.find((c) => c.id === next.id);
        if (character === undefined) {
          if (next.reason === 'needed') continue;
          return fail(`No character "${next.id}" in the source project.`);
        }
        const byId = target.characters.find((c) => c.id === character.id);
        const byName = target.characters.find((c) => same(c.name, character.name));
        const match = byId ?? byName;
        planned.push({
          ...next,
          name: character.name,
          collision:
            match === undefined
              ? null
              : {
                  targetId: match.id,
                  targetName: match.name,
                  match: byId === undefined ? 'name' : 'id',
                  choices: ALL,
                },
        });
      } else if (KIND_OF[next.kind] !== undefined) {
        const kind = KIND_OF[next.kind] ?? 'location';
        const element = elementsOf(source, kind).find((e) => e.id === next.id);
        if (element === undefined) {
          if (next.reason === 'needed') continue;
          return fail(`No ${kind} "${next.id}" in the source project.`);
        }
        const byId = elementsOf(target, kind).find((e) => e.id === element.id);
        const byName = elementsOf(target, kind).find((e) => same(e.name, element.name));
        const match = byId ?? byName;
        planned.push({
          ...next,
          name: element.name,
          collision:
            match === undefined
              ? null
              : {
                  targetId: match.id,
                  targetName: match.name,
                  match: byId === undefined ? 'name' : 'id',
                  choices: ALL,
                },
        });
        // A place inside a larger place brings the larger one along.
        if (element.kind === 'location' && element.parentId !== null) {
          need('location', element.parentId, element.name);
        }
      } else if (next.kind === 'scene') {
        const scene = source.scenes.find((s) => s.id === next.id);
        if (scene === undefined) {
          if (next.reason === 'needed') continue;
          return fail(`No scene "${next.id}" in the source project.`);
        }
        const match = target.scenes.find((s) => s.id === scene.id);
        planned.push({
          ...next,
          name: sceneName(scene),
          collision:
            match === undefined
              ? null
              : { targetId: match.id, targetName: sceneName(match), match: 'id', choices: ALL },
        });
        for (const shot of source.shots.get(scene.id) ?? []) {
          for (const id of castOf(shot)) need('character', id, sceneName(scene));
        }
        for (const [kind, id] of worldOf(scene, source.shots.get(scene.id) ?? [])) {
          need(kind, id, sceneName(scene));
        }
        for (const id of scenesUsedBy(source.cuts.get(scene.id), scene.id))
          need('scene', id, sceneName(scene));
      } else if (next.kind === 'shot') {
        const shot = findShot(source, next.id);
        if (shot === undefined) return fail(`No shot "${next.id}" in the source project.`);
        // A shot of a scene that is copied whole comes with it.
        if (pickedScenes.has(shot.sceneId)) continue;
        const scene = source.scenes.find((s) => s.id === shot.sceneId);
        const name = `Scene ${String(scene?.position ?? 0)}, shot ${String(shot.position)}`;
        const match = (target.shots.get(spec.parentId ?? '') ?? []).find((s) => s.id === shot.id);
        planned.push({
          ...next,
          name,
          collision:
            match === undefined
              ? null
              : {
                  targetId: match.id,
                  targetName: `Shot ${String(match.position)}`,
                  match: 'id',
                  choices: ALL,
                },
        });
        for (const id of castOf(shot)) need('character', id, name);
        for (const [kind, id] of worldOf(undefined, [shot])) need(kind, id, name);
      } else if (next.kind === 'sound') {
        const sound = findSound(source, next.id);
        if (sound === undefined) return fail(`No sound "${next.id}" in the source project.`);
        if (pickedScenes.has(sound.sceneId)) continue;
        const inTarget = target.sounds.get(spec.parentId ?? '') ?? [];
        const byId = inTarget.find((s) => s.id === sound.id);
        const match = byId ?? inTarget.find((s) => same(s.name, sound.name));
        planned.push({
          ...next,
          name: sound.name,
          collision:
            match === undefined
              ? null
              : {
                  targetId: match.id,
                  targetName: match.name,
                  match: byId === undefined ? 'name' : 'id',
                  choices: ALL,
                },
        });
      }
    }
    return planned;
  },

  async apply(runtime, spec, plan, choices) {
    const source = await readMovie(runtime.store, spec.fromProjectId);
    const target = await readMovie(runtime.store, spec.toProjectId);
    const fromPrefix = projectPrefix(spec.fromProjectId);
    const toPrefix = projectPrefix(spec.toProjectId);

    // First decide where each item goes, so references between them can follow.
    const decided = plan.map((item) => {
      const choice = item.collision === null ? null : (choices.get(itemKey(item)) ?? 'skip');
      const targetId =
        choice === 'keepBoth'
          ? runtime.newId()
          : item.collision !== null
            ? item.collision.targetId
            : item.id;
      const outcome: CopyOutcome['outcome'] =
        choice === null
          ? 'copied'
          : choice === 'overwrite'
            ? 'overwritten'
            : choice === 'skip'
              ? 'skipped'
              : 'keptBoth';
      return { item, choice, targetId, outcome };
    });
    const ids = new Map<string, string>();
    for (const { item, targetId } of decided) {
      if (item.kind !== 'development' && targetId !== item.id) ids.set(item.id, targetId);
    }
    const rewriter = (extra: ReadonlyMap<string, string> = new Map()) =>
      createRewriter({ fromPrefix, toPrefix, ids: new Map([...ids, ...extra]) });

    const writes: WriteOperation[] = [];
    const put = (key: string, value: JsonValue): void => {
      writes.push({ type: 'put', key, value });
    };
    let nextScenePosition = Math.max(0, ...target.scenes.map((s) => s.position)) + 1;
    const nextShotPosition = new Map<string, number>();
    const takenCharacterNames = target.characters.map((c) => c.name);
    const takenWorldNames: Record<WorldKind, string[]> = {
      location: target.locations.map((e) => e.name),
      object: target.objects.map((e) => e.name),
    };
    const takenSoundNames = (target.sounds.get(spec.parentId ?? '') ?? []).map((s) => s.name);

    for (const { item, choice, targetId } of decided) {
      if (choice === 'skip') continue;
      if (item.kind === 'development') {
        put(movieDevelopmentKey(spec.toProjectId), source.development);
      } else if (item.kind === 'character') {
        const character = source.characters.find((c) => c.id === item.id);
        if (character === undefined) continue;
        const key = (projectId: string, id: string): string => `${characterPrefix(projectId)}${id}`;
        if (choice === 'overwrite')
          await removeFiles(runtime, `${key(spec.toProjectId, targetId)}/`);
        const rewrite = rewriter();
        await moveFiles(runtime, `${key(spec.fromProjectId, character.id)}/`, rewrite.key);
        const value = rewrite.value(character) as Character;
        const name =
          choice === 'keepBoth' ? freeName(character.name, takenCharacterNames) : character.name;
        takenCharacterNames.push(name);
        put(key(spec.toProjectId, targetId), { ...value, id: targetId, name });
      } else if (KIND_OF[item.kind] !== undefined) {
        const kind = KIND_OF[item.kind] ?? 'location';
        const element = elementsOf(source, kind).find((e) => e.id === item.id);
        if (element === undefined) continue;
        if (choice === 'overwrite') {
          await removeFiles(runtime, `${elementKey(spec.toProjectId, kind, targetId)}/`);
        }
        const rewrite = rewriter();
        await moveFiles(
          runtime,
          `${elementKey(spec.fromProjectId, kind, element.id)}/`,
          rewrite.key,
        );
        const value = rewrite.value(element) as WorldElement;
        const name =
          choice === 'keepBoth' ? freeName(element.name, takenWorldNames[kind]) : element.name;
        takenWorldNames[kind].push(name);
        put(elementKey(spec.toProjectId, kind, targetId), { ...value, id: targetId, name });
      } else if (item.kind === 'scene') {
        const scene = source.scenes.find((s) => s.id === item.id);
        if (scene === undefined) continue;
        const existing = target.scenes.find((s) => s.id === targetId);
        if (choice === 'overwrite') {
          for (const prefix of [
            shotPrefix(spec.toProjectId, targetId),
            soundPrefix(spec.toProjectId, targetId),
          ]) {
            for (const entry of await runtime.store.list(prefix))
              writes.push({ type: 'delete', key: entry.key });
            await removeFiles(runtime, prefix);
          }
          writes.push({
            type: 'delete',
            key: `${projectPrefix(spec.toProjectId)}movie/edit-history/${targetId}`,
          });
          writes.push({ type: 'delete', key: editKey(spec.toProjectId, targetId) });
          writes.push({
            type: 'delete',
            key: `${projectPrefix(spec.toProjectId)}movie/edit-drafts/${targetId}`,
          });
        }
        const position =
          choice === 'overwrite' && existing !== undefined
            ? existing.position
            : nextScenePosition++;
        const rewrite = rewriter();
        put(movieSceneKey(spec.toProjectId, targetId), {
          ...(rewrite.value(scene) as Scene),
          id: targetId,
          position,
        });
        for (const shot of source.shots.get(scene.id) ?? []) {
          put(`${shotPrefix(spec.toProjectId, targetId)}${shot.id}`, rewrite.value(shot));
        }
        for (const sound of source.sounds.get(scene.id) ?? []) {
          put(`${soundPrefix(spec.toProjectId, targetId)}${sound.id}`, rewrite.value(sound));
        }
        await moveFiles(runtime, shotPrefix(spec.fromProjectId, scene.id), rewrite.key);
        await moveFiles(runtime, soundPrefix(spec.fromProjectId, scene.id), rewrite.key);
        const cut = source.cuts.get(scene.id);
        if (cut !== undefined) put(editKey(spec.toProjectId, targetId), rewrite.value(cut));
      } else if (item.kind === 'shot') {
        const shot = findShot(source, item.id);
        const parentId = spec.parentId;
        if (shot === undefined || parentId === null) continue;
        const shotKey = (projectId: string, sceneId: string, id: string): string =>
          `${shotPrefix(projectId, sceneId)}${id}`;
        const existing = (target.shots.get(parentId) ?? []).find((s) => s.id === targetId);
        if (choice === 'overwrite')
          await removeFiles(runtime, `${shotKey(spec.toProjectId, parentId, targetId)}/`);
        const last =
          nextShotPosition.get(parentId) ??
          Math.max(0, ...(target.shots.get(parentId) ?? []).map((s) => s.position));
        const position =
          choice === 'overwrite' && existing !== undefined ? existing.position : last + 1;
        if (position > last) nextShotPosition.set(parentId, position);
        const rewrite = rewriter(
          new Map([
            [shot.sceneId, parentId],
            [shot.id, targetId],
          ]),
        );
        await moveFiles(
          runtime,
          `${shotKey(spec.fromProjectId, shot.sceneId, shot.id)}/`,
          rewrite.key,
        );
        put(shotKey(spec.toProjectId, parentId, targetId), {
          ...(rewrite.value(shot) as Shot),
          id: targetId,
          sceneId: parentId,
          position,
        });
      } else if (item.kind === 'sound') {
        const sound = findSound(source, item.id);
        const parentId = spec.parentId;
        if (sound === undefined || parentId === null) continue;
        const soundKey = (projectId: string, sceneId: string, id: string): string =>
          `${soundPrefix(projectId, sceneId)}${id}`;
        if (choice === 'overwrite')
          await removeFiles(runtime, `${soundKey(spec.toProjectId, parentId, targetId)}/`);
        const rewrite = rewriter(
          new Map([
            [sound.sceneId, parentId],
            [sound.id, targetId],
          ]),
        );
        await moveFiles(
          runtime,
          `${soundKey(spec.fromProjectId, sound.sceneId, sound.id)}/`,
          rewrite.key,
        );
        const name = choice === 'keepBoth' ? freeName(sound.name, takenSoundNames) : sound.name;
        takenSoundNames.push(name);
        put(soundKey(spec.toProjectId, parentId, targetId), {
          ...(rewrite.value(sound) as Sound),
          id: targetId,
          sceneId: parentId,
          name,
        });
      }
    }
    await runtime.store.batch(writes);
    return decided.map(({ item, targetId, outcome }) => ({
      kind: item.kind,
      id: item.id,
      name: item.name,
      targetId,
      outcome,
    }));
  },
};

/**
 * The guided way to a first film: the smallest set of steps that ends in a
 * finished piece, each one done in its stage or handed to the coordinator.
 * A step counts as done from what the project holds, however it was done.
 */
export const firstFilmPath: GuidedPath = {
  steps: [
    {
      id: 'idea',
      title: 'Say what the film is',
      body: 'Write the logline in Development: the whole film in one or two sentences. Everything after it, from scenes to shots, is built on it. Free.',
      stage: 'development',
      ask: 'Help me write the logline, premise and tone of this film. Ask me what it is about first.',
    },
    {
      id: 'scene',
      title: 'Write a scene',
      body: 'In Script, write one scene: where it happens, what is done and said. One short scene is enough for a first film. Free, apart from a writer agent at a few cents.',
      stage: 'script',
      ask: 'Write the first scene of this film from the development, short enough for a first film.',
    },
    {
      id: 'cast',
      title: 'Cast a character',
      body: 'In Casting, describe how a character looks and make a portrait. The portrait keeps them the same in every clip. A portrait costs about a cent; the price is on the button.',
      stage: 'casting',
      ask: 'Cast the main character of this film: describe their appearance and make one portrait. Tell me the price first.',
    },
    {
      id: 'shots',
      title: 'Plan the shots',
      body: 'In Shots, split the scene into shots of a few seconds each: what the camera sees, who is in it, the line spoken. Free.',
      stage: 'shots',
      ask: 'Break the first scene into shots of four to eight seconds each.',
    },
    {
      id: 'clip',
      title: 'Make your first clip',
      body: 'Make the clip of one shot. Clips are the expensive part, so start with one and look at it before making the rest. The price is on the button.',
      stage: 'shots',
      ask: 'Make the clip of the first shot. Tell me the price before you start.',
    },
    {
      id: 'cut',
      title: 'Cut it together',
      body: 'In Edit, the clips play in order. Trim one, add a title card, then export the film to a file. Free.',
      stage: 'edit',
      ask: 'Put the first scene together in the Edit stage with a title card at the start, then tell me how to export it.',
    },
  ],
  done: async (runtime, projectId) => {
    const movie = await readMovie(runtime.store, projectId);
    const shots = [...movie.shots.values()].flat();
    const done = new Set<string>();
    if (movie.development.logline.trim() !== '') done.add('idea');
    if (movie.scenes.some((scene) => scene.body.trim() !== '')) done.add('scene');
    if (movie.characters.some((character) => character.portraitId !== null)) done.add('cast');
    if (shots.length > 0) done.add('shots');
    if (shots.some((shot) => shot.clip?.status === 'ready')) done.add('clip');
    if (
      [...movie.cuts.values()].some(
        (cut) => (cut.items !== null && cut.items.length > 0) || cut.sounds.length > 0,
      )
    ) {
      done.add('cut');
    }
    return done;
  },
};

export const movieProjectSupport: ProjectSupport = {
  templates: movieTemplates,
  summarize: summarizeMovie,
  resources: movieCopier,
  path: firstFilmPath,
};
