import { Effect, SoundPlacement } from '@imp/audio';
import { z } from 'zod';
import { Grade, NEUTRAL_GRADE } from './grade.js';

export const MODE_ID = 'movie';

/** What the film is, before there is a script. Every field starts empty. */
export const Development = z.object({
  logline: z.string().describe('The film in one or two sentences.'),
  premise: z.string().describe('The situation, the main character and what is at stake.'),
  tone: z
    .string()
    .describe(
      'Genre and mood. Every picture of the film is drawn in this mood, and in the visual style (movie.style) where one is written; a film without one is drawn in its tone alone.',
    ),
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
  body: z
    .string()
    .describe(
      'The scene in Fountain screenplay form, without its heading: action paragraphs, a CHARACTER name in capitals on its own line above their dialogue, (how it is said) in brackets on its own line, TRANSITIONS TO:.',
    ),
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
  /**
   * Whether the clip was made without sound of its own, because silence was
   * asked for. Clips made before sound was the default were silent whenever
   * the dialogue was recorded apart.
   */
  silent: z.boolean().default(false),
  /** Whether the shot's recorded dialogue plays over the clip: lines of voice-only characters. */
  voiceApart: z.boolean().default(false),
  /** The key frame the clip was made to start on, or null when it was made from words and guides. */
  startFrameId: z.string().nullable().default(null),
  /** The end frame the clip was made to land on, or null when its end was left to the model. */
  endFrameId: z.string().nullable().default(null),
  /**
   * The clip of the shot before that this one carries on from, when it started
   * on that clip's last frame. A new clip there leaves this one out of step.
   */
  continuesFrom: z.object({ shotId: z.string(), clipKey: z.string() }).nullable().default(null),
  costUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type Clip = z.infer<typeof Clip>;

/** Whether the recorded dialogue of the shot plays over a clip. */
export const dialogueOver = (clip: Pick<Clip, 'silent' | 'voiceApart'>): boolean =>
  clip.voiceApart || clip.silent;

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
/**
 * A pickup: a shot the edit asked for after the fact, such as a reaction or a
 * cutaway that covers a jump. Until its clip is ready it stands in the cut as
 * a slate of its planned length, so the scene can be timed around it.
 */
export const Pickup = z.object({
  /** What the cut needs it for, in the words of whoever asked. */
  reason: z.string(),
  /** How long the slate stands in the cut until the clip arrives. */
  seconds: z.number().min(0.5).max(30),
  /** "person", or the role of the agent that asked. */
  requestedBy: z.string(),
  requestedAt: z.string(),
});
export type Pickup = z.infer<typeof Pickup>;

/** How a shot comes after the one before it. */
export const ShotJoin = z.enum(['cut', 'continues', 'action']);
export type ShotJoin = z.infer<typeof ShotJoin>;

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
  lengthSeconds: z
    .number()
    .min(0.5)
    .max(30)
    .nullable()
    .default(null)
    .describe(
      'How long the shot holds in the finished cut, in seconds, from what happens in it: a glance 1.5, a reaction 2.5, a line plus a beat, a walk across a room 7. Vary it with the rhythm of the scene. Null when not planned: the clip then fits the line, or 4 seconds, and the edit does not trim by it. The clip is made a little longer, so the edit can trim it to its best moment.',
    ),
  lengthReason: z
    .string()
    .default('')
    .describe('Why the shot holds that long, in a few words, for the editor.'),
  join: ShotJoin.default('cut').describe(
    'How the shot comes after the one before it in the scene. "cut": a new angle or place, its own key frame. "continues": the same camera carries on, so the clip starts on the last frame of the clip before and the action flows on; it waits for that clip. "action": a cut on action, the same instant from a new angle; its key frame is painted to match where the shot before ends (its end frame, or the last frame of its clip).',
  ),
  cutReason: z
    .string()
    .default('')
    .describe(
      'Why the cut to this shot happens, for the editor: on a movement, on a look, on a line, to show a reaction, to move time on.',
    ),
  dialogue: DialogueTake.nullable().default(null),
  /** Painted first frames of the shot; the chosen one is what the clip starts on. */
  frames: z.array(KeyFrame).default([]),
  frameId: z.string().nullable().default(null),
  /** Painted last frames; the chosen one is what the clip ends on, where the model takes one. */
  endFrames: z.array(KeyFrame).default([]),
  endFrameId: z.string().nullable().default(null),
  clip: Clip.nullable().default(null),
  /**
   * Earlier ready clips of the shot, newest first. Making a new clip keeps the
   * one it replaces here, so a better earlier take can be put back.
   */
  takes: z.array(Clip).default([]),
  /** Set when the shot was asked for from the edit, to fill a gap in the cut. */
  pickup: Pickup.nullable().default(null),
});
export type Shot = z.infer<typeof Shot>;

/**
 * A sound laid on the timeline of a scene. The type lives in the audio engine,
 * which the audio editor shares, so the Edit stage and the editor edit the same data.
 */
export { SoundPlacement } from '@imp/audio';

/** How a piece comes in after the one before it. */
export const TransitionKind = z.enum(['cut', 'dissolve', 'dip-black', 'dip-white', 'wipe']);
export type TransitionKind = z.infer<typeof TransitionKind>;

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
  /** How fast the clip plays: 0.5 is slow motion, 2 double speed. Off speed, its own sound is silent. */
  speed: z.number().min(0.1).max(8).default(1),
  /** Plays the stretch backwards, without its own sound. */
  reverse: z.boolean().default(false),
  /** Seconds its last frame is held after it has played: a freeze frame. */
  holdSeconds: z.number().min(0).max(30).default(0),
  /** A punch-in: 1 shows the whole frame, 2 half its width. */
  zoom: z.number().min(1).max(4).default(1),
  /** The zoom it ends on, for a slow push in or pull out; null keeps one zoom. */
  zoomTo: z.number().min(1).max(4).nullable().default(null),
  /** The point zoomed on, as shares of the frame's width and height. */
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  /** How the piece comes in after the one before it: a cut, or a dissolve, dip or wipe. */
  transition: TransitionKind.default('cut'),
  /** How long the transition takes; a dissolve or wipe never covers more than half of either piece. */
  transitionSeconds: z.number().min(0.1).max(5).default(1),
  /** Its colour grade, before the film's look. */
  grade: Grade.default(NEUTRAL_GRADE),
});
export type CutItem = z.infer<typeof CutItem>;

/** A piece as filmed: at its own speed, forwards, unzoomed, with no frame held. */
export const PLAIN_PIECE = {
  speed: 1,
  reverse: false,
  holdSeconds: 0,
  zoom: 1,
  zoomTo: null,
  focusX: 0.5,
  focusY: 0.5,
  transition: 'cut',
  transitionSeconds: 1,
  grade: NEUTRAL_GRADE,
} as const satisfies Partial<CutItem>;

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
  /** Processing of the recording (EQ, noise reduction and the like), set in the audio editor. */
  effects: z.array(Effect).max(12).default([]),
});
export type CutLine = z.infer<typeof CutLine>;

/** What a piece of text on screen is for; each kind has a style of its own by default. */
export const TextKind = z.enum(['title', 'lower-third', 'subtitle', 'caption', 'credits']);
export type TextKind = z.infer<typeof TextKind>;

/**
 * What a text follows in time instead of keeping a time of its own: a piece of
 * the picture, or a line that is heard (from a shot, a placed dialogue
 * recording or a character lane, as movie.edit.get lists them under spoken).
 * from and to are the share of that piece or line the text covers, so that a
 * long line can be shown as several subtitles that keep up when the line is
 * moved, trimmed or recorded again.
 */
export const TextAnchor = z.object({
  on: z.enum(['item', 'shot', 'placement', 'lane']),
  id: z.string(),
  from: z.number().min(0).max(1).default(0),
  to: z.number().min(0).max(1).default(1),
});
export type TextAnchor = z.infer<typeof TextAnchor>;

/**
 * A piece of text over the picture of a scene, on the text lane: a title, a
 * lower third, a subtitle, an in-frame caption or end credits. It is drawn by
 * Imp, not by the video model, so it is always legible and can be changed.
 */
export const TextItem = z.object({
  id: z.string(),
  kind: TextKind,
  text: z.string(),
  /** Seconds on the scene timeline. With an anchor, where the anchor was when last seen. */
  startSeconds: z.number().min(0),
  durationSeconds: z.number().min(0.2),
  /** The text style from movie.edit.text.style.list. */
  styleId: z.string(),
  anchor: TextAnchor.nullable().default(null),
  /** Where in the frame, 0 to 1 from the left and from the top, when not where the style puts it. */
  x: z.number().min(0).max(1).nullable().default(null),
  y: z.number().min(0).max(1).nullable().default(null),
  /** Made by movie.edit.subtitles.generate or movie.edit.credits.generate, and replaced when they run again. */
  generated: z.boolean().default(false),
});
export type TextItem = z.infer<typeof TextItem>;

/** The fonts texts can be set in. They ship with Imp, so a film looks the same everywhere. */
export const TextFont = z.enum(['sans', 'serif', 'mono']);
export type TextFont = z.infer<typeof TextFont>;

/**
 * How a kind of text looks and moves, shared by the whole film so that every
 * subtitle or lower third matches.
 */
export const TextStyle = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  font: TextFont,
  weight: z.number().int().min(300).max(900).default(400),
  italic: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  /** The height of the letters, in percent of the frame height. */
  size: z.number().min(1).max(25),
  /** Extra space between letters, in em. */
  tracking: z.number().min(-0.1).max(0.5).default(0),
  /** Line height, as a multiple of the size. */
  leading: z.number().min(0.8).max(2.5).default(1.2),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** An outline around the letters: its colour and width in percent of the size (0 for none). */
  outlineColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
  outline: z.number().min(0).max(30).default(0),
  /** How dark the soft shadow under the letters is, 0 for none. */
  shadow: z.number().min(0).max(1).default(0),
  /** A box behind the text: its colour and how opaque it is (0 for none). */
  boxColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
  box: z.number().min(0).max(1).default(0),
  align: z.enum(['left', 'center', 'right']),
  /** Where the text sits, 0 to 1 from the left and from the top of the frame. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** Which edge of the text block sits at y. */
  anchor: z.enum(['top', 'middle', 'bottom']),
  /** The widest a line may be, in percent of the frame width. */
  width: z.number().min(10).max(100).default(80),
  /** How the text comes on and goes off. A roll moves the text up through the frame over its length. */
  enter: z.enum(['cut', 'fade', 'rise', 'type']).default('fade'),
  exit: z.enum(['cut', 'fade']).default('fade'),
  /** Seconds the entrance and the exit take. */
  ease: z.number().min(0).max(3).default(0.3),
  roll: z.boolean().default(false),
});
export type TextStyle = z.infer<typeof TextStyle>;

export const SceneCut = z.object({
  sceneId: z.string(),
  items: z.array(CutItem).nullable().default(null),
  sounds: z.array(SoundPlacement).default([]),
  lines: z.array(CutLine).default([]),
  /** The text lane: titles, lower thirds, subtitles, captions and credits over the picture. */
  texts: z.array(TextItem).default([]),
});
export type SceneCut = z.infer<typeof SceneCut>;

/**
 * What a person asked an agent to do to a stretch of a scene: the words, and
 * the time range or items it is about. Kept on the draft so that the
 * proposal can be read against what was asked.
 */
export const CutRequest = z.object({
  instruction: z.string(),
  /** Seconds on the scene timeline, or null for the whole scene. */
  fromSeconds: z.number().min(0).nullable().default(null),
  toSeconds: z.number().min(0).nullable().default(null),
  /** The items picked, when the request is about pieces rather than a time range. */
  itemIds: z.array(z.string()).default([]),
  createdAt: z.iso.datetime(),
});
export type CutRequest = z.infer<typeof CutRequest>;

/**
 * Changes agents propose to the cut of a scene, kept apart from it until a
 * person keeps or discards them. base is the cut as it was when the draft
 * began, so that what the agent changed can be told from what the person
 * changed since.
 */
export const CutDraft = z.object({
  sceneId: z.string(),
  base: SceneCut,
  cut: SceneCut,
  /** The draft's own steps, so that an agent can undo its own work. */
  undo: z.array(SceneCut).default([]),
  redo: z.array(SceneCut).default([]),
  /** The crew members who worked on it, by id, with their role. */
  authors: z.array(z.object({ id: z.string(), role: z.string() })).default([]),
  request: CutRequest.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CutDraft = z.infer<typeof CutDraft>;

/** The cuts a scene went through, for undo and redo. */
export const CutHistory = z.object({
  undo: z.array(SceneCut).default([]),
  redo: z.array(SceneCut).default([]),
});
export type CutHistory = z.infer<typeof CutHistory>;
