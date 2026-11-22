import {
  CommandError,
  decodeUtf8,
  defineCommand,
  requireProject,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import { characterPrefix, readScenes, renumbered, scriptFileKey } from './commands.js';
import { fdxToFountain, toFdx } from './fdx.js';
import {
  fountainScenes,
  fountainTitlePage,
  headingLine,
  looseWords,
  parseFountain,
  scriptLength,
  scriptLines,
  toFountain,
  type ScriptElement,
} from './fountain.js';
import { Character, MODE_ID, type Scene } from './schema.js';
import { screenplayPdf } from './screenplay-pdf.js';
import { readShots } from './shots.js';
import { utf8 } from './text.js';

/**
 * The script as a screenplay: how long it runs, the lines its characters say
 * and the shots that say them, and the script as a file (Fountain, Final
 * Draft or a PDF to print) or read in from one.
 */

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');

/** A scene as one stretch of screenplay: its heading, then its text. */
export function sceneElements(scene: Pick<Scene, 'heading' | 'body'>): ScriptElement[] {
  const heading = headingLine(scene.heading);
  const body = parseFountain(scene.body);
  return heading === '' ? body : [{ type: 'heading', text: heading.replace(/^\./, '') }, ...body];
}

/**
 * Gives every scene heading a number, in order. A heading that has one
 * already (#12#) keeps it, and numbering goes on after it.
 */
export function numberScenes(elements: readonly ScriptElement[]): ScriptElement[] {
  let last = 0;
  return elements.map((element) => {
    if (element.type !== 'heading') return element;
    if (element.sceneNumber !== undefined) {
      const given = Number.parseInt(element.sceneNumber, 10);
      if (Number.isFinite(given)) last = given;
      return element;
    }
    last += 1;
    return { ...element, sceneNumber: String(last) };
  });
}

const fileSafe = (text: string): string =>
  text
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'script';

async function charactersOf(store: KeyValueStore, projectId: string) {
  return (await store.list(characterPrefix(projectId))).map((entry) =>
    Character.parse(entry.value),
  );
}

/** A name as a script writes it and as the cast list has it, compared loosely. */
const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

export const ScriptLineView = z.object({
  index: z.number().describe('The line’s place among the scene’s spoken lines, from 0.'),
  speaker: z.string().describe('The name the script gives the speaker.'),
  characterId: z
    .string()
    .nullable()
    .describe('The cast member of that name, or null when nobody in the cast has it.'),
  extension: z.string().nullable().describe('V.O., O.S. and the like, or null.'),
  direction: z.string().describe('How it is said, from the parentheticals, or empty.'),
  words: z.string().describe('The words, without emphasis marks.'),
  shotIds: z.array(z.string()).describe('The shots of the scene that speak these words.'),
});
export type ScriptLineView = z.infer<typeof ScriptLineView>;

export const UnscriptedLine = z.object({
  shotId: z.string(),
  position: z.number(),
  /** The cast member who speaks it in the shot, by name, or null. */
  speaker: z.string().nullable(),
  words: z.string(),
});

/** The lines of a scene's script, each with the shots that speak it, and shot lines the script lacks. */
export async function sceneLines(
  store: KeyValueStore,
  projectId: string,
  scene: Scene,
): Promise<{ lines: ScriptLineView[]; unscripted: z.infer<typeof UnscriptedLine>[] }> {
  const cast = await charactersOf(store, projectId);
  const shots = await readShots(store, projectId, scene.id);
  const lines = scriptLines(scene.body).map((line) => {
    const loose = looseWords(line.words);
    return {
      ...line,
      characterId: cast.find((character) => sameName(character.name, line.speaker))?.id ?? null,
      shotIds: shots
        .filter((shot) => loose !== '' && looseWords(shot.line) === loose)
        .map((shot) => shot.id),
    };
  });
  const scripted = new Set(lines.map((line) => looseWords(line.words)));
  const unscripted = shots
    .filter((shot) => shot.line.trim() !== '' && !scripted.has(looseWords(shot.line)))
    .map((shot) => ({
      shotId: shot.id,
      position: shot.position,
      speaker: cast.find((character) => character.id === shot.speakerId)?.name ?? null,
      words: shot.line,
    }));
  return { lines, unscripted };
}

export function createScriptCommands(): readonly Command[] {
  const get = defineCommand({
    id: 'movie.script.get',
    title: 'Read the script as a screenplay',
    description:
      'How long the script runs (pages, and minutes at the usual page a minute) and, for each scene, its length, how many lines are spoken and how many shot lines are not in the script. Scene texts are Fountain screenplay text. Use movie.script.lines for one scene’s lines and the shots that speak them.',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: z.object({
      pages: z.number(),
      minutes: z.number(),
      scenes: z.array(
        z.object({
          sceneId: z.string(),
          position: z.number(),
          heading: z.string(),
          pages: z.number(),
          lines: z.number(),
          unscripted: z.number(),
        }),
      ),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'movie.script.get', projectId, MODE_ID);
      const scenes = await readScenes(runtime.store, projectId);
      const all: ScriptElement[] = [];
      const rows = [];
      for (const scene of scenes) {
        const elements = sceneElements(scene);
        all.push(...elements);
        const { lines, unscripted } = await sceneLines(runtime.store, projectId, scene);
        rows.push({
          sceneId: scene.id,
          position: scene.position,
          heading: scene.heading,
          pages: scriptLength(elements).pages,
          lines: lines.length,
          unscripted: unscripted.length,
        });
      }
      const length = scriptLength(all);
      return { pages: length.pages, minutes: length.minutes, scenes: rows };
    },
  });

  const lines = defineCommand({
    id: 'movie.script.lines',
    title: 'List the lines of a scene',
    description:
      'The lines spoken in a scene’s script, in order: who says them (and the cast member of that name), how (the parentheticals) and the words, with the shots of the scene whose line has the same words. Also lists shot lines that are not in the script. To have a shot speak a script line, set its speakerId, line and delivery with movie.shot.update; to change the words everywhere, change the scene text (movie.scene.update) and the shot.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, sceneId: SceneId }),
    output: z.object({
      lines: z.array(ScriptLineView),
      unscripted: z.array(UnscriptedLine),
    }),
    handler: async ({ runtime }, { projectId, sceneId }) => {
      const id = 'movie.script.lines';
      await requireProject(runtime.store, id, projectId, MODE_ID);
      const scene = (await readScenes(runtime.store, projectId)).find(
        (candidate) => candidate.id === sceneId,
      );
      if (scene === undefined)
        throw new CommandError('invalid_input', id, `No scene "${sceneId}".`);
      return sceneLines(runtime.store, projectId, scene);
    },
  });

  const exportScript = defineCommand({
    id: 'movie.script.export',
    title: 'Write the script as a file',
    description:
      'Writes the whole script as a file for the person to download from the Script screen: a PDF set in the standard screenplay layout (to read, print or send), Fountain (plain text that screenwriting apps open) or Final Draft (.fdx). It has a title page with the film’s name. Returns the file’s key and name, and its length in pages.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      format: z.enum(['pdf', 'fountain', 'fdx']).default('pdf'),
      author: z.string().max(200).optional().describe('Who wrote it, for the title page.'),
      sceneNumbers: z
        .boolean()
        .default(true)
        .describe(
          'Numbers the scenes in both margins of the PDF and in the Final Draft file, as shooting scripts are. A number written in a heading (#12#) is kept.',
        ),
    }),
    output: z.object({
      blobKey: z.string(),
      fileName: z.string(),
      mediaType: z.string(),
      pages: z.number(),
    }),
    handler: async ({ runtime }, { projectId, format, author, sceneNumbers }) => {
      const id = 'movie.script.export';
      const project = await requireProject(runtime.store, id, projectId, MODE_ID);
      const scenes = await readScenes(runtime.store, projectId);
      const written = scenes.flatMap((scene) => sceneElements(scene));
      const elements = sceneNumbers ? numberScenes(written) : written;
      const title: Record<string, string> = {
        title: project.name,
        ...(author === undefined || author.trim() === ''
          ? {}
          : { credit: 'Written by', author: author.trim() }),
        'draft date': runtime.now().toISOString().slice(0, 10),
      };
      const name = fileSafe(project.name);
      const file =
        format === 'pdf'
          ? {
              bytes: screenplayPdf(title, elements),
              mediaType: 'application/pdf',
              fileName: `${name}.pdf`,
            }
          : format === 'fdx'
            ? {
                bytes: utf8(toFdx(title, elements)),
                mediaType: 'application/xml',
                fileName: `${name}.fdx`,
              }
            : {
                bytes: utf8(toFountain(title, scenes)),
                mediaType: 'text/plain',
                fileName: `${name}.fountain`,
              };
      const blobKey = scriptFileKey(projectId, file.fileName);
      await runtime.blobs.put(blobKey, { bytes: file.bytes, mediaType: file.mediaType });
      return {
        blobKey,
        fileName: file.fileName,
        mediaType: file.mediaType,
        pages: scriptLength(elements).pages,
      };
    },
  });

  const importScript = defineCommand({
    id: 'movie.script.import',
    title: 'Bring in a script',
    description:
      'Reads a screenplay (Fountain or Final Draft .fdx) and adds its scenes after the existing ones: each heading starts a scene, a synopsis line after it (= …) becomes the summary, and the rest becomes the scene text in Fountain. Give the words as text, or the key of an uploaded file. Nothing that is there already changes.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      text: z.string().max(2_000_000).optional().describe('The script itself.'),
      fileKey: z.string().optional().describe('An uploaded file’s key, instead of text.'),
      format: z
        .enum(['fountain', 'fdx'])
        .optional()
        .describe('Defaults to what the file looks like.'),
    }),
    output: z.object({
      scenes: z.array(z.object({ id: z.string(), position: z.number(), heading: z.string() })),
      title: z.string().nullable(),
    }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.script.import';
      await requireProject(runtime.store, id, input.projectId, MODE_ID);
      let source = input.text;
      if (source === undefined && input.fileKey !== undefined) {
        const blob = await runtime.blobs.get(input.fileKey);
        if (blob === undefined) {
          throw new CommandError(
            'invalid_input',
            id,
            `Nothing is stored under "${input.fileKey}".`,
          );
        }
        source = decodeUtf8(blob.bytes).replace(/^\uFEFF/, '');
        await runtime.blobs.delete(input.fileKey);
      }
      if (source === undefined || source.trim() === '') {
        throw new CommandError('invalid_input', id, 'Give the script as text or as a file.');
      }
      const fdx =
        input.format === 'fdx' || (input.format === undefined && /<FinalDraft\b/.test(source));
      const fountain = fdx ? fdxToFountain(source) : source;
      const found = fountainScenes(fountain);
      if (found.length === 0) {
        throw new CommandError('invalid_input', id, 'There are no scenes in it.');
      }
      const scenes = await readScenes(runtime.store, input.projectId);
      const added: Scene[] = found.map((scene) => ({
        id: runtime.newId(),
        position: 0,
        heading: scene.heading,
        summary: scene.summary,
        body: scene.body,
        locationId: null,
        locationStateId: null,
      }));
      const all = [...scenes, ...added];
      await runtime.store.batch(renumbered(input.projectId, all));
      return {
        scenes: added.map((scene) => ({
          id: scene.id,
          position: all.indexOf(scene) + 1,
          heading: scene.heading,
        })),
        title: fountainTitlePage(fountain)['title'] ?? null,
      };
    },
  });

  return [get, lines, exportScript, importScript];
}
