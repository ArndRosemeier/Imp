import { z } from 'zod';

/** How a fade moves: evenly, or as a soft S that starts and ends gently. */
export const FadeCurve = z.enum(['linear', 'smooth']);
export type FadeCurve = z.infer<typeof FadeCurve>;

/**
 * A sound laid on a timeline: the region of the audio editor and the audio
 * lane item of the Edit stage are this one type. It names its source by kind
 * and id, so the file is found where the source keeps it.
 *
 * Fields added after the Edit stage first stored cuts have defaults, so every
 * stored placement still reads.
 */
export const SoundPlacement = z.object({
  id: z.string(),
  /**
   * What plays: a sound of the scene, the own sound of a shot's clip (taken apart
   * from its picture), or the recorded dialogue of a shot.
   */
  source: z.enum(['sound', 'clip', 'dialogue']).default('sound'),
  soundId: z.string(),
  /** Where the shot is, for the sources "clip" and "dialogue". */
  sceneId: z.string().default(''),
  shotId: z.string().default(''),
  /** Seconds skipped at the start of the source. */
  trimStartSeconds: z.number().min(0).default(0),
  /** Seconds from the start of the scene. */
  startSeconds: z.number().min(0),
  /** 0 to 1. Music under dialogue is quieter than effects. */
  volume: z.number().min(0).max(1),
  fadeInSeconds: z.number().min(0),
  fadeOutSeconds: z.number().min(0),
  /** Repeats until the scene ends, for ambience and score that must outlast the shots. */
  loop: z.boolean(),
  /** How long it plays, in seconds. Null plays the source to its end (or, looping, to the scene's end). */
  durationSeconds: z.number().positive().nullable().default(null),
  /** Left -1 to right 1; 0 is the middle. */
  pan: z.number().min(-1).max(1).default(0),
  /** The shape of both fades. */
  fadeCurve: FadeCurve.default('linear'),
});
export type SoundPlacement = z.infer<typeof SoundPlacement>;
