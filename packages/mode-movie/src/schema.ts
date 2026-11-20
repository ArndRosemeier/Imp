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
  /** Percent done, where the model reports it. */
  progress: z.number().nullable(),
  /** Why it failed. */
  error: z.string().nullable(),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type Clip = z.infer<typeof Clip>;

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
  clip: Clip.nullable().default(null),
});
export type Shot = z.infer<typeof Shot>;
