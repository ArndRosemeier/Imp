import { SoundPlacement } from '@imp/audio';
import { z } from 'zod';

export const MODE_ID = 'movie';

/** What the film is, before there is a script. Every field starts empty. */
export const Development = z.object({
  logline: z.string().describe('The film in one or two sentences.'),
  premise: z.string().describe('The situation, the main character and what is at stake.'),
  tone: z.string().describe('Genre, mood and visual style.'),
  treatment: z.string().describe('The story told in prose from beginning to end.'),
});
export type Development = z.infer<typeof Development>;

export const EMPTY_DEVELOPMENT: Development = { logline: '', premise: '', tone: '', treatment: '' };

export const Scene = z.object({
  id: z.string(),
  /** Where the scene sits in the script, starting at 1. */
  position: z.number().int().positive(),
  heading: z.string().describe('The slug line, for example "INT. LIGHTHOUSE, LAMP ROOM - NIGHT".'),
  summary: z.string().describe('What happens in the scene, in a sentence or two.'),
  body: z.string().describe('The scene in screenplay form: action lines and dialogue.'),
  locationId: z
    .string()
    .nullable()
    .default(null)
    .describe('Where the scene happens: a location from world.location.list, or null.'),
  locationStateId: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The state the location is in during the scene, for example "Night, storm", or null for its usual look.',
    ),
});
export type Scene = z.infer<typeof Scene>;

/** A generated picture of a character. The bytes are in the blob store under `blobKey`. */
export const CharacterImage = z.object({
  id: z.string(),
  blobKey: z.string(),
  mediaType: z.string(),
  /** The prompt and model it was made with, so it can be made again or varied. */
  prompt: z.string(),
  model: z.string(),
  createdAt: z.iso.datetime(),
});
export type CharacterImage = z.infer<typeof CharacterImage>;

/** A spoken line in a character's voice, kept as a blob. */
export const VoiceSample = z.object({
  blobKey: z.string(),
  mediaType: z.string(),
  /** What is said in the recording. */
  line: z.string(),
  /** The direction the speech model was given. */
  direction: z.string(),
  model: z.string(),
  createdAt: z.iso.datetime(),
});
export type VoiceSample = z.infer<typeof VoiceSample>;

export const Character = z.object({
  id: z.string(),
  name: z.string().min(1),
  part: z.string().describe('The role in the story, for example "protagonist".'),
  description: z.string().describe('Who the character is: background, want, flaw.'),
  appearance: z
    .string()
    .describe('How the character looks, precise enough to generate images from.'),
  voice: z.string().describe('How the character sounds and speaks.'),
  images: z.array(CharacterImage).default([]),
  /** The image that stands for the character, or null while there is none. */
  portraitId: z.string().nullable().default(null),
  /** A recording of how the character sounds, or null before one was made. */
  voiceSample: VoiceSample.nullable().default(null),
  /**
   * A voice that is heard but never seen, such as a narrator. It stays out of
   * every clip prompt and portrait list; its lines are recorded apart.
   */
  voiceOnly: z.boolean().default(false),
  /**
   * Gets a lane of its own in the Edit stage, where its free-standing lines are
   * recorded and placed in time. A narrator has both this and voiceOnly.
   */
  ownLane: z.boolean().default(false),
});
export type Character = z.infer<typeof Character>;

/** What was made of a sound: the file, and what it was made with. */
export const SoundTake = z.object({
  blobKey: z.string(),
  mediaType: z.string(),
  /** The prompt and model it was made with, so it can be made again or varied. */
  prompt: z.string(),
  model: z.string(),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type SoundTake = z.infer<typeof SoundTake>;

/** A sound effect or a piece of music that belongs to a scene. */
export const Sound = z.object({
  id: z.string(),
  sceneId: z.string(),
  kind: z
    .enum(['effect', 'music'])
    .describe(
      '"effect" for a noise or an ambience, "music" for score. It cannot be changed later.',
    ),
  name: z.string().max(80).describe('A short label, for example "Storm wind" or "Mara\'s theme".'),
  description: z
    .string()
    .max(1000)
    .describe(
      'What is heard. For an effect: the source, its character, how it starts and ends, for example "a heavy wooden door slamming shut in a stone hall, long echo". For music: instruments, tempo, mood and how it develops.',
    ),
  take: SoundTake.nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type Sound = z.infer<typeof Sound>;

/** A generated clip of a shot. Clips take minutes, so one starts as a job and becomes a file. */
export const Clip = z.object({
  status: z.enum(['pending', 'ready', 'failed']),
  /** The provider's job, to look at again while it is being made and to download from. */
  jobId: z.string(),
  /** Where the video is, once it is ready. */
  blobKey: z.string().nullable(),
  mediaType: z.string().nullable(),
  /** The prompt and model it was made with, so it can be made again or varied. */
  prompt: z.string(),
  model: z.string(),
  /** How many portraits guided it. Zero when the model takes none. */
  portraits: z.number().int().default(0),
  /** What the guiding images showed, by name: characters, the location's view, objects. */
  guides: z.array(z.string()).default([]),
  /** Percent done, where the model reports it. */
  progress: z.number().nullable(),
  /** Why it failed. */
  error: z.string().nullable(),
  /** The length it was asked for, in seconds. Null for clips made before this was kept. */
  durationSeconds: z.number().nullable().default(null),
  /** Whether the shot's dialogue was recorded apart, so the clip itself is silent. */
  silent: z.boolean().default(false),
  /** The key frame the clip was made to start on, or null when it was made from words and guides. */
  startFrameId: z.string().nullable().default(null),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type Clip = z.infer<typeof Clip>;

/**
 * The spoken line of a shot, recorded in the voice of its speaker. Video
 * models invent a voice of their own from the text, so the dialogue is made
 * apart and laid over a silent clip.
 */
export const DialogueTake = z.object({
  blobKey: z.string(),
  mediaType: z.string(),
  /** The words and direction it was recorded with; when they differ from the shot, it is out of date. */
  line: z.string(),
  direction: z.string(),
  model: z.string(),
  durationSeconds: z.number().nullable(),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type DialogueTake = z.infer<typeof DialogueTake>;

/**
 * A still of the first moment of a shot, painted from the pictures of its
 * place, people and objects. A clip that starts exactly on it shows the same
 * room and the same faces as every other shot made this way.
 */
export const KeyFrame = z.object({
  id: z.string(),
  blobKey: z.string(),
  mediaType: z.string(),
  prompt: z.string(),
  model: z.string(),
  /** What the reference pictures showed, by name, closest first. Empty when the model took none. */
  guides: z.array(z.string()),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type KeyFrame = z.infer<typeof KeyFrame>;

/** One uninterrupted piece of film within a scene. */
export const Shot = z.object({
  id: z.string(),
  sceneId: z.string(),
  /** Where the shot sits in its scene, starting at 1. */
  position: z.number().int().positive(),
  description: z
    .string()
    .describe('What the camera shows: place, framing, movement, light. One shot, a few seconds.'),
  characterIds: z
    .array(z.string())
    .describe('The characters seen in the shot. Their appearance and portrait guide the clip.'),
  performance: z
    .string()
    .describe(
      'What the bodies do, as visibly as the moment needs: who moves how, and how the others react. Video models underplay movement unless it is spelled out.',
    ),
  locationId: z
    .string()
    .nullable()
    .default(null)
    .describe("The location seen, when it is not the scene's. Null for the scene's location."),
  locationStateId: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The state of the location in this shot, when it differs from the scene's. Null to follow the scene.",
    ),
  viewId: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The view of the location the shot is filmed from (its views are in world.location.get), or null for the location's first view. Shots of one place from different sides use different views.",
    ),
  objects: z
    .array(
      z.object({
        objectId: z.string().describe('An object from world.object.list.'),
        stateId: z
          .string()
          .nullable()
          .default(null)
          .describe('The state it is in, or null for its usual look.'),
      }),
    )
    .default([])
    .describe('The objects seen in the shot. Their look and picture guide the clip.'),
  speakerId: z.string().nullable().describe('Who speaks the line, or null for a silent shot.'),
  line: z
    .string()
    .describe(
      'The words spoken, written the way they are said. Punctuation and wording carry the emotion: a line written flat is spoken flat, whatever happens in the picture.',
    ),
  delivery: z
    .string()
    .describe(
      'How the line is said: emotion, intensity, pace, breath. For example "screaming over the wind, voice cracking".',
    ),
  dialogue: DialogueTake.nullable().default(null),
  /** Painted first frames of the shot; the chosen one is what the clip starts on. */
  frames: z.array(KeyFrame).default([]),
  frameId: z.string().nullable().default(null),
  clip: Clip.nullable().default(null),
});
export type Shot = z.infer<typeof Shot>;

/**
 * A sound laid on the timeline of a scene. The type lives in the audio engine,
 * which the audio editor shares, so the Edit stage and the editor edit the same data.
 */
export { SoundPlacement } from '@imp/audio';

/**
 * One piece of a scene's cut: a stretch of a shot's clip, or a title card. The
 * same shot can be cut into several items (a split) or used twice (a paste),
 * and an item can come from another scene.
 */
export const CutItem = z.object({
  id: z.string(),
  kind: z.enum(['shot', 'title']),
  /** Where the shot is, for kind "shot". */
  sceneId: z.string(),
  shotId: z.string(),
  /** Seconds taken off the start and the end of the clip. */
  trimStartSeconds: z.number().min(0),
  trimEndSeconds: z.number().min(0),
  /** How loud the recorded dialogue plays, 0 to 1. */
  dialogueVolume: z.number().min(0).max(1),
  /** How loud the clip's own sound plays, 0 to 1. Zero once it was taken apart or when it is unwanted. */
  clipAudioVolume: z.number().min(0).max(1).default(1),
  /** Seconds to fade in from black and out to black at the edges of the item. */
  fadeInSeconds: z.number().min(0),
  fadeOutSeconds: z.number().min(0),
  /** The words and the length of a title card, for kind "title". */
  text: z.string(),
  titleSeconds: z.number().min(0.5),
});
export type CutItem = z.infer<typeof CutItem>;

/**
 * The cut of a scene: its items in playing order and the sounds that lie under
 * them. While items is null the cut is the scene's shots in order, whole;
 * the first edit makes it explicit.
 */
/**
 * A line of a character with a lane of its own: spoken words that belong to no
 * shot, placed on the character's lane at a time of the scene.
 */
export const CutLine = z.object({
  id: z.string(),
  characterId: z.string(),
  text: z.string(),
  delivery: z.string().default(''),
  /** The recording, or null before one was made. */
  take: DialogueTake.nullable().default(null),
  /** Seconds from the start of the scene. */
  startSeconds: z.number().min(0).default(0),
  trimStartSeconds: z.number().min(0).default(0),
  volume: z.number().min(0).max(1).default(1),
  fadeInSeconds: z.number().min(0).default(0),
  fadeOutSeconds: z.number().min(0).default(0),
});
export type CutLine = z.infer<typeof CutLine>;

export const SceneCut = z.object({
  sceneId: z.string(),
  items: z.array(CutItem).nullable().default(null),
  sounds: z.array(SoundPlacement).default([]),
  lines: z.array(CutLine).default([]),
});
export type SceneCut = z.infer<typeof SceneCut>;

/** The cuts a scene went through, for undo and redo. */
export const CutHistory = z.object({
  undo: z.array(SceneCut).default([]),
  redo: z.array(SceneCut).default([]),
});
export type CutHistory = z.infer<typeof CutHistory>;
