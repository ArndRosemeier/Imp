import { z } from 'zod';
import type { Asset } from './model.js';

/** Runs a command in the open project (the project id is added) and answers its output. */
export type RunInProject = (id: string, input: Record<string, unknown>) => Promise<unknown>;

const Added = z.object({
  sound: z.object({ id: z.string(), take: z.object({ blobKey: z.string() }) }),
});

/** How a sound asset is named to a scene's cut: one of its sounds, or a shot's dialogue. */
export type SceneSound =
  | { source: 'sound'; soundId: string; blobKey: string }
  | { source: 'dialogue'; shotId: string; shotSceneId: string; blobKey: string };

/** Whether an asset can become sound of a scene at all. */
export const isPlayableSound = (asset: Asset): boolean =>
  asset.modality === 'sound' && asset.blobKey !== null;

/**
 * Makes a sound from the library a sound of a scene. A sound or recorded line
 * of the scene is used as it is; anything else (an imported file, another
 * scene's sound) is added to the scene first, with movie.sound.fromFile.
 */
export async function soundForScene(
  run: RunInProject,
  sceneId: string,
  asset: Asset,
): Promise<SceneSound> {
  if (asset.blobKey === null) throw new Error(`“${asset.title}” has no sound yet.`);
  const { refs } = asset;
  if (asset.id.startsWith('movie:dialogue:') && refs['shotId'] !== undefined) {
    return {
      source: 'dialogue',
      shotId: refs['shotId'],
      shotSceneId: refs['sceneId'] ?? sceneId,
      blobKey: asset.blobKey,
    };
  }
  if (
    (asset.kind === 'effect' || asset.kind === 'music') &&
    refs['sceneId'] === sceneId &&
    refs['soundId'] !== undefined
  ) {
    return { source: 'sound', soundId: refs['soundId'], blobKey: asset.blobKey };
  }
  const added = Added.parse(
    await run('movie.sound.fromFile', {
      sceneId,
      blobKey: asset.blobKey,
      kind: asset.kind === 'music' ? 'music' : 'effect',
      name: asset.title.slice(0, 80),
    }),
  );
  return { source: 'sound', soundId: added.sound.id, blobKey: added.sound.take.blobKey };
}
