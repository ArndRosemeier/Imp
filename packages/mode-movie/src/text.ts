import {
  CommandError,
  defineCommand,
  requireProject,
  type Command,
  type CoreRuntime,
  type KeyValueStore,
  patchOf,
} from '@imp/core';
import { z } from 'zod';
import { characterPrefix, movieSceneKey, subtitleFileKey, textStylesKey } from './commands.js';
import {
  commitCut,
  itemsOf,
  openCut,
  readCut,
  requireScene,
  TextView,
  viewOf,
  type Acting,
  type CutView,
} from './edit.js';
import {
  Character,
  CutItem,
  MODE_ID,
  PLAIN_PIECE,
  Scene,
  TextAnchor,
  TextFont,
  TextKind,
  TextStyle,
  type SceneCut,
  type TextItem,
} from './schema.js';
import {
  DEFAULT_TEXT_STYLES,
  styleIdFor,
  subtitleCues,
  toSrt,
  toVtt,
  type TimedCue,
} from './text-layout.js';

/**
 * The text lane: titles, lower thirds, subtitles, captions and credits over
 * the picture, and the film's text styles. Texts are part of a scene's cut,
 * so they are undone, drafted by agents and reviewed like any other edit.
 */

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');
const TextId = z.string().describe('The id of a text from movie.edit.get (texts).');

/** How long a new text of each kind shows when no length is given. */
const DEFAULT_SECONDS: Record<TextKind, number> = {
  title: 4,
  'lower-third': 4.5,
  subtitle: 3,
  caption: 4,
  credits: 20,
};

/** The film's text styles: the defaults, with the film's changes and its own styles. */
export async function readStyles(store: KeyValueStore, projectId: string): Promise<TextStyle[]> {
  const stored = await store.get(textStylesKey(projectId));
  const own = stored === undefined ? [] : z.array(TextStyle).parse(stored);
  const defaults = DEFAULT_TEXT_STYLES.map(
    (style) => own.find((candidate) => candidate.id === style.id) ?? style,
  );
  const added = own.filter(
    (style) => !DEFAULT_TEXT_STYLES.some((builtIn) => builtIn.id === style.id),
  );
  return [...defaults, ...added];
}

const isBuiltIn = (styleId: string): boolean =>
  DEFAULT_TEXT_STYLES.some((style) => style.id === styleId);

const AnchorInput = z
  .object({
    on: TextAnchor.shape.on.describe(
      '"item" follows a piece of the picture (an item id); "shot", "placement" or "lane" follow a line that is heard, as movie.edit.get lists it under spoken (its source and id).',
    ),
    id: z.string(),
    from: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('The share of the piece or line where the text comes on. Defaults to 0.'),
    to: z.number().min(0).max(1).optional().describe('The share where it goes off. Defaults to 1.'),
  })
  .describe(
    'Ties the text to a piece or a line, so that it keeps up when they move or change length. Its own start and length are then ignored.',
  );

const Words = z.string().min(1).max(4000);

const PlaceFields = {
  x: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .describe(
      'Where across the frame, 0 left to 1 right, instead of where its style puts it. Null goes back to the style.',
    ),
  y: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .describe('Where down the frame, 0 top to 1 bottom. Null goes back to the style.'),
};

/** Looks for what an anchor points at, so that a text is not tied to nothing. */
function requireAnchor(view: CutView, commandId: string, anchor: z.infer<typeof AnchorInput>) {
  const found =
    anchor.on === 'item'
      ? view.items.some((item) => item.itemId === anchor.id && item.durationSeconds > 0)
      : view.spoken.some((line) => line.source === anchor.on && line.id === anchor.id);
  if (!found) {
    throw new CommandError(
      'invalid_input',
      commandId,
      anchor.on === 'item'
        ? `No playing item "${anchor.id}" in this cut.`
        : `No heard line from ${anchor.on} "${anchor.id}" in this cut (see spoken in movie.edit.get).`,
    );
  }
  return TextAnchor.parse({ from: 0, to: 1, ...anchor });
}

async function requireStyle(
  store: KeyValueStore,
  commandId: string,
  projectId: string,
  id: string,
) {
  const styles = await readStyles(store, projectId);
  if (!styles.some((style) => style.id === id)) {
    throw new CommandError(
      'invalid_input',
      commandId,
      `No text style "${id}". The styles are: ${styles.map((style) => style.id).join(', ')}.`,
    );
  }
}

async function look(at: Acting, projectId: string, cut: SceneCut): Promise<CutView> {
  const { store } = at.runtime;
  return viewOf(store, projectId, cut.sceneId, cut, await itemsOf(store, projectId, cut));
}

async function shown(at: Acting, projectId: string, cut: SceneCut, textId: string) {
  const view = await look(at, projectId, cut);
  const text = view.texts.find((candidate) => candidate.id === textId);
  if (text === undefined) throw new Error('A text went missing right after it was written.');
  return text;
}

async function scenesOf(store: KeyValueStore, projectId: string): Promise<Scene[]> {
  return (await store.list(movieSceneKey(projectId, '')))
    .map((entry) => Scene.parse(entry.value))
    .sort((a, b) => a.position - b.position);
}

/** A role id as a credit reads it: "film-editor" is "Film Editor". */
const roleName = (roleId: string): string =>
  (roleId.split('/').at(-1) ?? roleId)
    .split(/[-_]/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const Crew = z.object({ name: z.string(), roleId: z.string() });

async function credits(runtime: CoreRuntime, projectId: string, title: string): Promise<string> {
  const characters = (await runtime.store.list(characterPrefix(projectId)))
    .map((entry) => Character.parse(entry.value))
    .filter((character) => character.name.trim() !== '');
  const crew = (await runtime.store.list('crew/')).flatMap((entry) => {
    const parsed = Crew.safeParse(entry.value);
    // The coordinator runs the crew; it is not one of the people who made the film.
    return parsed.success && parsed.data.roleId !== 'coordinator' ? [parsed.data] : [];
  });
  const blocks: string[] = [title];
  if (characters.length > 0) {
    blocks.push(
      [
        'Cast',
        ...characters.map((character) =>
          character.voiceOnly ? `${character.name} (voice)` : character.name,
        ),
      ].join('\n'),
    );
  }
  if (crew.length > 0) {
    blocks.push(
      [
        'Crew',
        ...crew.map((member) => {
          const role = roleName(member.roleId);
          return member.name === role ? role : `${role} · ${member.name}`;
        }),
      ].join('\n'),
    );
  }
  blocks.push('Made with Imp');
  return blocks.join('\n\n');
}

export function createTextCommands(): readonly Command[] {
  const add = defineCommand({
    id: 'movie.edit.text.add',
    title: 'Add text',
    description:
      'Puts a text over the picture of a scene, on its text lane: a title, a lower third (a name and a role on two lines, for example "Mara Venn\\nCaptain of the Kestrel"), a subtitle, a caption pinned in the frame (a place, a date, a sign the video model could not write) or credits. Imp draws it, so it is always legible. Give it a time, or anchor it to a piece of the picture or a heard line so it follows them when the cut changes. Its look comes from a film-wide text style (movie.edit.text.style.list); by default the style of its kind.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      kind: TextKind,
      text: Words.describe('The words. A new line breaks the line.'),
      startSeconds: z
        .number()
        .min(0)
        .max(36000)
        .optional()
        .describe('When it comes on, in seconds of the scene. Defaults to 0.'),
      durationSeconds: z
        .number()
        .min(0.2)
        .max(3600)
        .optional()
        .describe('How long it shows. Defaults to a length that suits the kind.'),
      styleId: z.string().optional().describe('A text style id. Defaults to the kind’s style.'),
      anchor: AnchorInput.optional(),
      ...PlaceFields,
    }),
    output: TextView,
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.text.add';
      const at = { runtime, actor };
      const { cut } = await openCut(at, id, input.projectId, input.sceneId);
      const styleId = input.styleId ?? styleIdFor(input.kind);
      await requireStyle(runtime.store, id, input.projectId, styleId);
      const anchor =
        input.anchor === undefined
          ? null
          : requireAnchor(await look(at, input.projectId, cut), id, input.anchor);
      const text: TextItem = {
        id: runtime.newId(),
        kind: input.kind,
        text: input.text,
        startSeconds: input.startSeconds ?? 0,
        durationSeconds: input.durationSeconds ?? DEFAULT_SECONDS[input.kind],
        styleId,
        anchor,
        x: input.x ?? null,
        y: input.y ?? null,
        generated: false,
      };
      const after = { ...cut, texts: [...cut.texts, text] };
      await commitCut(at, input.projectId, cut, after);
      return shown(at, input.projectId, after, text.id);
    },
  });

  const set = defineCommand({
    id: 'movie.edit.text.set',
    title: 'Change text',
    description:
      'Changes a text of the text lane: its words, kind, style, time, anchor or place in the frame. Fields left out stay as they are. Giving a start or a length without an anchor frees an anchored text to keep that time; anchor null does the same.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      textId: TextId,
      text: Words.optional(),
      kind: TextKind.optional(),
      styleId: z.string().optional(),
      startSeconds: z.number().min(0).max(36000).optional(),
      durationSeconds: z.number().min(0.2).max(3600).optional(),
      anchor: AnchorInput.nullable().optional(),
      ...PlaceFields,
    }),
    output: TextView,
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.text.set';
      const at = { runtime, actor };
      const { cut } = await openCut(at, id, input.projectId, input.sceneId);
      const before = cut.texts.find((candidate) => candidate.id === input.textId);
      if (before === undefined) {
        throw new CommandError('invalid_input', id, `No text "${input.textId}" in this cut.`);
      }
      if (input.styleId !== undefined) {
        await requireStyle(runtime.store, id, input.projectId, input.styleId);
      }
      const view = await look(at, input.projectId, cut);
      const placed = view.texts.find((candidate) => candidate.id === input.textId);
      const timed = input.startSeconds !== undefined || input.durationSeconds !== undefined;
      const anchor =
        input.anchor === undefined
          ? timed
            ? null
            : before.anchor
          : input.anchor === null
            ? null
            : requireAnchor(view, id, input.anchor);
      // A text that lets go of its anchor keeps the time it showed at.
      const next: TextItem = {
        ...before,
        text: input.text ?? before.text,
        kind: input.kind ?? before.kind,
        styleId: input.styleId ?? before.styleId,
        startSeconds: input.startSeconds ?? placed?.startSeconds ?? before.startSeconds,
        durationSeconds: input.durationSeconds ?? placed?.durationSeconds ?? before.durationSeconds,
        anchor,
        x: input.x === undefined ? before.x : input.x,
        y: input.y === undefined ? before.y : input.y,
        // A generated text that a person or an agent changed is theirs now, and stays.
        generated:
          before.generated && input.text === undefined && input.anchor === undefined && !timed,
      };
      const after = {
        ...cut,
        texts: cut.texts.map((candidate) => (candidate.id === input.textId ? next : candidate)),
      };
      await commitCut(at, input.projectId, cut, after);
      return shown(at, input.projectId, after, next.id);
    },
  });

  const remove = defineCommand({
    id: 'movie.edit.text.remove',
    title: 'Remove text',
    description: 'Takes texts off the text lane of a scene. Undo brings them back.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      textIds: z.array(TextId).min(1).max(500),
    }),
    output: z.object({ removed: z.number() }),
    handler: async ({ runtime, actor }, { projectId, sceneId, textIds }) => {
      const at = { runtime, actor };
      const { cut } = await openCut(at, 'movie.edit.text.remove', projectId, sceneId);
      const texts = cut.texts.filter((text) => !textIds.includes(text.id));
      const removed = cut.texts.length - texts.length;
      if (removed > 0) await commitCut(at, projectId, cut, { ...cut, texts });
      return { removed };
    },
  });

  const styleList = defineCommand({
    id: 'movie.edit.text.style.list',
    title: 'List text styles',
    description:
      'Returns the text styles of the film. Every kind of text has a style with its own id (title, lower-third, subtitle, caption, credits); more can be made. A style sets the font (sans, serif or mono), weight, size in percent of the frame height, colour, outline, shadow, box, alignment, place in the frame, how the text comes on and goes off, and whether it rolls like end credits.',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: z.object({ styles: z.array(TextStyle.extend({ builtIn: z.boolean() })) }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'movie.edit.text.style.list', projectId, MODE_ID);
      return {
        styles: (await readStyles(runtime.store, projectId)).map((style) => ({
          ...style,
          builtIn: isBuiltIn(style.id),
        })),
      };
    },
  });

  const StyleFields = patchOf(TextStyle.omit({ id: true }));
  const styleSet = defineCommand({
    id: 'movie.edit.text.style.set',
    title: 'Change or add a text style',
    description:
      'Changes a text style of the film, or makes a new one when styleId is left out (give it a name). Every text in that style changes with it, in every scene, at once. Fields left out stay as they are (a new style starts from the style of basedOn, or the title style).',
    effect: 'write',
    input: StyleFields.extend({
      projectId: ProjectId,
      styleId: z.string().optional().describe('The style to change; left out, a new style.'),
      basedOn: z
        .string()
        .optional()
        .describe('For a new style, the style it starts from. Defaults to "title".'),
      font: TextFont.optional(),
    }),
    output: TextStyle,
    handler: async ({ runtime }, { projectId, styleId, basedOn, ...fields }) => {
      const id = 'movie.edit.text.style.set';
      await requireProject(runtime.store, id, projectId, MODE_ID);
      const styles = await readStyles(runtime.store, projectId);
      let start: TextStyle | undefined;
      if (styleId === undefined) {
        const base = basedOn ?? 'title';
        start = styles.find((style) => style.id === base);
        if (start === undefined) {
          throw new CommandError('invalid_input', id, `No text style "${base}" to start from.`);
        }
        start = {
          ...start,
          id: runtime.newId(),
          name: fields.name ?? `${start.name} copy`,
        };
      } else {
        start = styles.find((style) => style.id === styleId);
        if (start === undefined) {
          throw new CommandError('invalid_input', id, `No text style "${styleId}".`);
        }
      }
      const defined = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      const next = TextStyle.parse({ ...start, ...defined });
      const own = styles.filter(
        (style) =>
          !isBuiltIn(style.id) ||
          JSON.stringify(style) !==
            JSON.stringify(DEFAULT_TEXT_STYLES.find((builtIn) => builtIn.id === style.id)),
      );
      const written = [...own.filter((style) => style.id !== next.id), next];
      await runtime.store.batch([{ type: 'put', key: textStylesKey(projectId), value: written }]);
      return next;
    },
  });

  const styleRemove = defineCommand({
    id: 'movie.edit.text.style.remove',
    title: 'Remove or reset a text style',
    description:
      'Removes a text style the film made; its texts take the style of their kind. A built-in style (title, lower-third, subtitle, caption, credits) is put back as it was instead.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, styleId: z.string() }),
    output: z.object({ removed: z.boolean(), reset: z.boolean() }),
    handler: async ({ runtime }, { projectId, styleId }) => {
      await requireProject(runtime.store, 'movie.edit.text.style.remove', projectId, MODE_ID);
      const stored = await runtime.store.get(textStylesKey(projectId));
      const own = stored === undefined ? [] : z.array(TextStyle).parse(stored);
      const rest = own.filter((style) => style.id !== styleId);
      if (rest.length !== own.length) {
        await runtime.store.batch([{ type: 'put', key: textStylesKey(projectId), value: rest }]);
      }
      const builtIn = isBuiltIn(styleId);
      return { removed: !builtIn && rest.length !== own.length, reset: builtIn };
    },
  });

  const generate = defineCommand({
    id: 'movie.edit.subtitles.generate',
    title: 'Make subtitles from the dialogue',
    description:
      'Writes subtitles for every line that is heard in the scenes (shot dialogue, placed dialogue and character lanes), in the subtitle style. Long lines are split into several subtitles at sentences and pauses. Each subtitle is anchored to its line, so it keeps up when the line is moved, trimmed or recorded again. Subtitles made this way before are replaced; subtitles written by hand stay.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneIds: z
        .array(z.string())
        .optional()
        .describe('The scenes to subtitle. Defaults to every scene.'),
      names: z
        .boolean()
        .default(false)
        .describe(
          'Put the speaker’s name before each line ("MARA: …"), as subtitles for the deaf do.',
        ),
      styleId: z.string().optional().describe('A text style. Defaults to "subtitle".'),
    }),
    output: z.object({
      scenes: z.array(z.object({ sceneId: z.string(), subtitles: z.number() })),
    }),
    handler: async ({ runtime, actor }, { projectId, sceneIds, names, styleId }) => {
      const id = 'movie.edit.subtitles.generate';
      const at = { runtime, actor };
      await requireProject(runtime.store, id, projectId, MODE_ID);
      const style = styleId ?? styleIdFor('subtitle');
      await requireStyle(runtime.store, id, projectId, style);
      const ids = sceneIds ?? (await scenesOf(runtime.store, projectId)).map((scene) => scene.id);
      const scenes = [];
      for (const sceneId of ids) {
        const { cut } = await openCut(at, id, projectId, sceneId);
        const view = await look(at, projectId, cut);
        const made: TextItem[] = [];
        for (const line of view.spoken) {
          if (line.durationSeconds <= 0) continue;
          for (const cue of subtitleCues(line.text)) {
            made.push({
              id: runtime.newId(),
              kind: 'subtitle',
              text:
                names && line.who !== 'Someone'
                  ? `${line.who.toUpperCase()}: ${cue.text}`
                  : cue.text,
              startSeconds:
                Math.round((line.startsAtSeconds + line.durationSeconds * cue.from) * 1000) / 1000,
              durationSeconds: Math.max(0.2, line.durationSeconds * (cue.to - cue.from)),
              styleId: style,
              anchor: { on: line.source, id: line.id, from: cue.from, to: cue.to },
              x: null,
              y: null,
              generated: true,
            });
          }
        }
        const kept = cut.texts.filter((text) => !(text.generated && text.kind === 'subtitle'));
        const after = { ...cut, texts: [...kept, ...made] };
        if (JSON.stringify(after.texts) !== JSON.stringify(cut.texts)) {
          await commitCut(at, projectId, cut, after);
        }
        scenes.push({ sceneId, subtitles: made.length });
      }
      return { scenes };
    },
  });

  const exportSubtitles = defineCommand({
    id: 'movie.edit.subtitles.export',
    title: 'Write a subtitle file',
    description:
      'Writes the subtitles of the film (or of the scenes named) as a subtitle file, SubRip (.srt) or WebVTT (.vtt), timed to the film as movie.edit.export lays the scenes one after the other. Use it to upload a film with subtitles that can be switched off. Reads the cut as it stands, not drafts. Returns the file’s key and name for the person to download from the Edit screen, and the first subtitles.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneIds: z.array(z.string()).optional().describe('Defaults to every scene, in order.'),
      format: z.enum(['srt', 'vtt']).default('srt'),
    }),
    output: z.object({
      blobKey: z.string(),
      fileName: z.string(),
      mediaType: z.string(),
      subtitles: z.number(),
      preview: z.string(),
    }),
    handler: async ({ runtime, actor }, { projectId, sceneIds, format }) => {
      const id = 'movie.edit.subtitles.export';
      const project = await requireProject(runtime.store, id, projectId, MODE_ID);
      const ids = sceneIds ?? (await scenesOf(runtime.store, projectId)).map((scene) => scene.id);
      const cues = await filmCues(
        { runtime, actor },
        id,
        projectId,
        ids,
        (text) => text.kind === 'subtitle',
      );
      const content = format === 'srt' ? toSrt(cues) : toVtt(cues);
      const mediaType = format === 'srt' ? 'application/x-subrip' : 'text/vtt';
      const fileName = `${fileSafe(project.name)}.${format}`;
      const blobKey = subtitleFileKey(projectId, fileName);
      await runtime.blobs.put(blobKey, {
        bytes: utf8(content),
        mediaType,
      });
      return {
        blobKey,
        fileName,
        mediaType,
        subtitles: cues.length,
        preview: (format === 'srt' ? toSrt(cues.slice(0, 4)) : toVtt(cues.slice(0, 4))).trim(),
      };
    },
  });

  const creditsGenerate = defineCommand({
    id: 'movie.edit.credits.generate',
    title: 'Make end credits',
    description:
      'Adds rolling end credits after the last piece of a scene (by default the last scene): a black card with the film’s title, its cast and the crew rolling up over it, in the credits style. Credits made this way before are replaced. Change the words afterwards with movie.edit.text.set and the length of the card with movie.edit.item.set (titleSeconds); the roll keeps up with it.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: z.string().optional().describe('The scene they end. Defaults to the last scene.'),
      seconds: z
        .number()
        .min(4)
        .max(600)
        .optional()
        .describe('How long the credits roll. Defaults to about a second and a half a line.'),
      text: Words.optional().describe(
        'The words, if not the ones Imp writes from the cast and crew.',
      ),
    }),
    output: z.object({ itemId: z.string(), text: TextView }),
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.credits.generate';
      const at = { runtime, actor };
      const project = await requireProject(runtime.store, id, input.projectId, MODE_ID);
      const sceneId = input.sceneId ?? (await scenesOf(runtime.store, input.projectId)).at(-1)?.id;
      if (sceneId === undefined) {
        throw new CommandError('invalid_input', id, 'The film has no scenes yet.');
      }
      const { cut, items } = await openCut(at, id, input.projectId, sceneId);
      const words = input.text ?? (await credits(runtime, input.projectId, project.name));
      const lineCount = words.split('\n').length;
      const seconds = input.seconds ?? Math.min(600, Math.max(8, Math.round(lineCount * 1.5 + 4)));
      // Credits made before go, with the black card they rolled over.
      const old = cut.texts.filter((text) => text.generated && text.kind === 'credits');
      const oldCards = new Set(
        old.flatMap((text) => (text.anchor?.on === 'item' ? [text.anchor.id] : [])),
      );
      const card: CutItem = CutItem.parse({
        id: runtime.newId(),
        kind: 'title',
        sceneId,
        shotId: '',
        trimStartSeconds: 0,
        trimEndSeconds: 0,
        dialogueVolume: 1,
        clipAudioVolume: 1,
        fadeInSeconds: 0.5,
        fadeOutSeconds: 1,
        text: '',
        titleSeconds: seconds,
        ...PLAIN_PIECE,
      });
      const text: TextItem = {
        id: runtime.newId(),
        kind: 'credits',
        text: words,
        startSeconds: 0,
        durationSeconds: seconds,
        styleId: styleIdFor('credits'),
        anchor: { on: 'item', id: card.id, from: 0, to: 1 },
        x: null,
        y: null,
        generated: true,
      };
      const after: SceneCut = {
        ...cut,
        items: [
          ...items.filter(
            (item) => !(oldCards.has(item.id) && item.kind === 'title' && item.text === ''),
          ),
          card,
        ],
        texts: [...cut.texts.filter((candidate) => !old.includes(candidate)), text],
      };
      await commitCut(at, input.projectId, cut, after);
      return { itemId: card.id, text: await shown(at, input.projectId, after, text.id) };
    },
  });

  return [
    add,
    set,
    remove,
    styleList,
    styleSet,
    styleRemove,
    generate,
    exportSubtitles,
    creditsGenerate,
  ];
}

const fileSafe = (text: string): string =>
  text
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'film';

/**
 * The texts of scenes laid one after the other as the film plays them, with
 * film times: what a subtitle file and the film export show. Texts whose
 * anchor is gone are left out.
 */
export async function filmTexts(
  at: Acting,
  commandId: string,
  projectId: string,
  sceneIds: readonly string[],
): Promise<{ texts: (TextView & { filmStartSeconds: number })[]; durationSeconds: number }> {
  const { store } = at.runtime;
  const texts: (TextView & { filmStartSeconds: number })[] = [];
  let offset = 0;
  for (const sceneId of sceneIds) {
    await requireScene(store, commandId, projectId, sceneId);
    const cut = await readCut(store, projectId, sceneId);
    const view = await viewOf(store, projectId, sceneId, cut, await itemsOf(store, projectId, cut));
    for (const text of view.texts) {
      if (text.orphaned) continue;
      // What lies past the end of the scene's picture is not in the film.
      const end = Math.min(text.startSeconds + text.durationSeconds, view.totalSeconds);
      if (end - text.startSeconds <= 0) continue;
      texts.push({
        ...text,
        durationSeconds: Math.round((end - text.startSeconds) * 1000) / 1000,
        filmStartSeconds: Math.round((offset + text.startSeconds) * 1000) / 1000,
      });
    }
    offset += view.totalSeconds;
  }
  return { texts, durationSeconds: offset };
}

async function filmCues(
  at: Acting,
  commandId: string,
  projectId: string,
  sceneIds: readonly string[],
  wanted: (text: TextView) => boolean,
): Promise<TimedCue[]> {
  const { texts } = await filmTexts(at, commandId, projectId, sceneIds);
  return texts
    .filter(wanted)
    .map((text) => ({
      startSeconds: text.filmStartSeconds,
      endSeconds: text.filmStartSeconds + text.durationSeconds,
      text: text.text,
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

/** Text as UTF-8 bytes, which every subtitle reader expects. */
export function utf8(text: string): Uint8Array {
  const escaped = encodeURIComponent(
    text.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    ),
  );
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] === '%') {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(escaped.charCodeAt(index));
    }
  }
  return Uint8Array.from(bytes);
}
