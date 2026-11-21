import {
  defineCommand,
  readProject,
  requireProject,
  type Command,
  type LibrarySource,
  type SourceAsset,
} from '@imp/core';
import { z } from 'zod';
import {
  characterPrefix,
  editKey,
  movieDevelopmentKey,
  movieSceneKey,
  shotPrefix,
  soundPrefix,
} from './commands.js';
import { Character, Development, MODE_ID, Scene, SceneCut, Shot, Sound } from './schema.js';

/** One recorded sound of the film, as the audio editor names it. */
export const LibrarySound = z.object({
  key: z.string().describe('The blob key, for audio.region.insert or audio.doc.create.'),
  label: z.string(),
  kind: z.enum(['dialogue', 'effect', 'music', 'voice']),
  sceneId: z.string().nullable().describe('The scene it belongs to; null for voice samples.'),
  sceneHeading: z.string().nullable(),
});
export type LibrarySound = z.infer<typeof LibrarySound>;

const ProjectId = z.string().describe('The id of a movie project from project.list.');

/**
 * Every recorded sound of a movie project in one list, in script order: each
 * scene's recorded dialogue by shot, then its effects and music, then the
 * voice samples of the cast. This is what the audio editor opens and what an
 * agent picks sources from.
 */
export const soundLibrary = defineCommand({
  id: 'movie.sound.library',
  title: 'List recorded sounds',
  description:
    'Returns every recorded sound of the film with its blob key: dialogue lines by shot, sound effects and music by scene, and voice samples of the cast. Use the keys to open sounds in the audio editor (audio.doc.create, audio.region.insert) or to measure them (audio.inspect).',
  effect: 'read',
  input: z.object({ projectId: ProjectId }),
  output: z.object({ sounds: z.array(LibrarySound) }),
  handler: async ({ runtime }, { projectId }) => {
    const { store } = runtime;
    await requireProject(store, 'movie.sound.library', projectId, MODE_ID);
    const scenes = (await store.list(movieSceneKey(projectId, '')))
      .map((entry) => Scene.parse(entry.value))
      .sort((a, b) => a.position - b.position);
    const sounds: LibrarySound[] = [];
    for (const scene of scenes) {
      const at = { sceneId: scene.id, sceneHeading: scene.heading };
      const shots = (await store.list(shotPrefix(projectId, scene.id)))
        .map((entry) => Shot.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      for (const shot of shots) {
        if (shot.dialogue === null) continue;
        const words = shot.dialogue.line.trim();
        sounds.push({
          key: shot.dialogue.blobKey,
          label: `Shot ${String(shot.position)}: ${words.length > 60 ? `${words.slice(0, 59)}…` : words}`,
          kind: 'dialogue',
          ...at,
        });
      }
      const sceneSounds = (await store.list(soundPrefix(projectId, scene.id)))
        .map((entry) => Sound.parse(entry.value))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const sound of sceneSounds) {
        if (sound.take === null) continue;
        sounds.push({
          key: sound.take.blobKey,
          label:
            sound.name === '' ? (sound.kind === 'music' ? 'Music' : 'Sound effect') : sound.name,
          kind: sound.kind,
          ...at,
        });
      }
    }
    const cast = (await store.list(characterPrefix(projectId)))
      .map((entry) => Character.parse(entry.value))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const character of cast) {
      if (character.voiceSample === null) continue;
      sounds.push({
        key: character.voiceSample.blobKey,
        label: `${character.name}, voice sample`,
        kind: 'voice',
        sceneId: null,
        sceneHeading: null,
      });
    }
    return { sounds };
  },
});

export const libraryCommands: readonly Command[] = [soundLibrary];

// The library

const excerpt = (text: string, length = 60): string => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};
const sceneLabel = (scene: Scene): string =>
  `Scene ${String(scene.position)}${scene.heading.trim() === '' ? '' : `, ${scene.heading.trim()}`}`;

const DEVELOPMENT_PARTS = [
  ['logline', 'Logline'],
  ['premise', 'Premise'],
  ['tone', 'Tone'],
  ['treatment', 'Treatment'],
] as const;

/**
 * Everything a movie project made, for the library: portraits and key frames,
 * clips, recorded dialogue and lines, effects, music and voice samples, and
 * the written development, scenes and lines.
 */
export const movieLibrarySource: LibrarySource = {
  id: MODE_ID,
  kinds: [
    { id: 'portrait', modality: 'image', label: 'Portrait', plural: 'Portraits' },
    { id: 'key-frame', modality: 'image', label: 'Key frame', plural: 'Key frames' },
    { id: 'clip', modality: 'video', label: 'Shot clip', plural: 'Shot clips' },
    { id: 'dialogue', modality: 'sound', label: 'Dialogue', plural: 'Dialogue' },
    { id: 'line', modality: 'sound', label: 'Lane line', plural: 'Lane lines' },
    { id: 'effect', modality: 'sound', label: 'Sound effect', plural: 'Effects' },
    { id: 'music', modality: 'sound', label: 'Music', plural: 'Music' },
    { id: 'voice', modality: 'sound', label: 'Voice sample', plural: 'Voice samples' },
    { id: 'development', modality: 'text', label: 'Development', plural: 'Development' },
    { id: 'scene', modality: 'text', label: 'Scene', plural: 'Scenes' },
    { id: 'spoken-line', modality: 'text', label: 'Spoken line', plural: 'Spoken lines' },
  ],
  list: async ({ store }, projectId) => {
    const project = await readProject(store, projectId);
    if (project?.mode !== MODE_ID) return [];
    const assets: SourceAsset[] = [];
    const cast = (await store.list(characterPrefix(projectId))).map((entry) =>
      Character.parse(entry.value),
    );
    const nameOf = (characterId: string | null): string =>
      cast.find((character) => character.id === characterId)?.name ?? '';

    for (const character of cast) {
      for (const image of character.images) {
        assets.push({
          id: `${MODE_ID}:portrait:${character.id}:${image.id}`,
          modality: 'image',
          kind: 'portrait',
          title: `${character.name}${image.id === character.portraitId ? ', portrait' : ''}`,
          context: character.part,
          origin: 'generated',
          blobKey: image.blobKey,
          mediaType: image.mediaType,
          createdAt: image.createdAt,
          open: { view: 'casting', focus: { characterId: character.id } },
          refs: { characterId: character.id, imageId: image.id },
        });
      }
      if (character.voiceSample !== null) {
        const sample = character.voiceSample;
        assets.push({
          id: `${MODE_ID}:voice:${character.id}`,
          modality: 'sound',
          kind: 'voice',
          title: `${character.name}, voice sample`,
          context: excerpt(sample.line),
          origin: 'generated',
          blobKey: sample.blobKey,
          mediaType: sample.mediaType,
          text: sample.line,
          createdAt: sample.createdAt,
          open: { view: 'casting', focus: { characterId: character.id } },
          refs: { characterId: character.id },
        });
      }
    }

    const development = await store.get(movieDevelopmentKey(projectId));
    if (development !== undefined) {
      const parsed = Development.parse(development);
      for (const [part, label] of DEVELOPMENT_PARTS) {
        if (parsed[part].trim() === '') continue;
        assets.push({
          id: `${MODE_ID}:development:${part}`,
          modality: 'text',
          kind: 'development',
          title: label,
          context: project.name,
          origin: 'written',
          text: parsed[part],
          open: { view: 'development', focus: {} },
          refs: { part },
        });
      }
    }

    const scenes = (await store.list(movieSceneKey(projectId, '')))
      .map((entry) => Scene.parse(entry.value))
      .sort((a, b) => a.position - b.position);
    for (const scene of scenes) {
      const where = sceneLabel(scene);
      if (scene.body.trim() !== '' || scene.summary.trim() !== '') {
        assets.push({
          id: `${MODE_ID}:scene:${scene.id}`,
          modality: 'text',
          kind: 'scene',
          title: where,
          context: excerpt(scene.summary, 90),
          origin: 'written',
          text: scene.body.trim() === '' ? scene.summary : scene.body,
          open: { view: 'script', focus: { sceneId: scene.id } },
          refs: { sceneId: scene.id },
        });
      }
      const shots = (await store.list(shotPrefix(projectId, scene.id)))
        .map((entry) => Shot.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      for (const shot of shots) {
        const shotName = `Shot ${String(shot.position)}`;
        const refs = { sceneId: scene.id, shotId: shot.id };
        const open = { view: 'shots', focus: refs };
        const speaker = nameOf(shot.speakerId);
        for (const frame of shot.frames) {
          assets.push({
            id: `${MODE_ID}:key-frame:${scene.id}:${shot.id}:${frame.id}`,
            modality: 'image',
            kind: 'key-frame',
            title: `${shotName}${frame.id === shot.frameId ? ', chosen frame' : ', frame'}`,
            context: where,
            origin: 'generated',
            blobKey: frame.blobKey,
            mediaType: frame.mediaType,
            text: excerpt(shot.description, 200),
            createdAt: frame.createdAt,
            open,
            refs: { ...refs, frameId: frame.id },
          });
        }
        if (shot.clip?.status === 'ready' && shot.clip.blobKey !== null) {
          assets.push({
            id: `${MODE_ID}:clip:${scene.id}:${shot.id}`,
            modality: 'video',
            kind: 'clip',
            title: `${shotName}${shot.description.trim() === '' ? '' : `: ${excerpt(shot.description, 50)}`}`,
            context: where,
            origin: 'generated',
            blobKey: shot.clip.blobKey,
            mediaType: shot.clip.mediaType,
            durationSeconds: shot.clip.durationSeconds,
            createdAt: shot.clip.createdAt,
            open,
            refs,
          });
        }
        if (shot.dialogue !== null) {
          assets.push({
            id: `${MODE_ID}:dialogue:${scene.id}:${shot.id}`,
            modality: 'sound',
            kind: 'dialogue',
            title: `${speaker === '' ? shotName : `${speaker}, ${shotName.toLowerCase()}`}: ${excerpt(shot.dialogue.line, 50)}`,
            context: where,
            origin: 'generated',
            blobKey: shot.dialogue.blobKey,
            mediaType: shot.dialogue.mediaType,
            text: shot.dialogue.line,
            durationSeconds: shot.dialogue.durationSeconds,
            createdAt: shot.dialogue.createdAt,
            open,
            refs,
          });
        }
        if (shot.line.trim() !== '') {
          assets.push({
            id: `${MODE_ID}:spoken-line:${scene.id}:${shot.id}`,
            modality: 'text',
            kind: 'spoken-line',
            title: `${speaker === '' ? shotName : speaker}: ${excerpt(shot.line, 50)}`,
            context: `${where}, ${shotName.toLowerCase()}`,
            origin: 'written',
            text:
              shot.delivery.trim() === '' ? shot.line : `${shot.line}\n(${shot.delivery.trim()})`,
            open,
            refs,
          });
        }
      }
      const sounds = (await store.list(soundPrefix(projectId, scene.id))).map((entry) =>
        Sound.parse(entry.value),
      );
      for (const sound of sounds) {
        if (sound.take === null) continue;
        assets.push({
          id: `${MODE_ID}:${sound.kind}:${scene.id}:${sound.id}`,
          modality: 'sound',
          kind: sound.kind,
          title:
            sound.name === '' ? (sound.kind === 'music' ? 'Music' : 'Sound effect') : sound.name,
          context: where,
          origin: 'generated',
          blobKey: sound.take.blobKey,
          mediaType: sound.take.mediaType,
          text: sound.description,
          createdAt: sound.take.createdAt,
          open: { view: 'sound', focus: { sceneId: scene.id, soundId: sound.id } },
          refs: { sceneId: scene.id, soundId: sound.id },
        });
      }
      const cut = SceneCut.safeParse((await store.get(editKey(projectId, scene.id))) ?? null);
      if (cut.success) {
        for (const line of cut.data.lines) {
          if (line.take === null) continue;
          const speakerName = nameOf(line.characterId);
          assets.push({
            id: `${MODE_ID}:line:${scene.id}:${line.id}`,
            modality: 'sound',
            kind: 'line',
            title: `${speakerName === '' ? 'Line' : speakerName}: ${excerpt(line.text, 50)}`,
            context: where,
            origin: 'generated',
            blobKey: line.take.blobKey,
            mediaType: line.take.mediaType,
            text: line.text,
            durationSeconds: line.take.durationSeconds,
            createdAt: line.take.createdAt,
            open: { view: 'edit', focus: { sceneId: scene.id } },
            refs: { sceneId: scene.id, lineId: line.id },
          });
        }
      }
    }
    return assets;
  },
};
