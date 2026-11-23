import {
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import { readScenes } from './commands.js';
import { MODE_ID } from './schema.js';

/**
 * Notes on the script from a read-through: what a first reader finds about a
 * scene while it is still words, when a change costs nothing. The critic
 * leaves them; the Screenwriter or the person deals with them and marks them
 * done.
 */
export const ScriptNote = z.object({
  id: z.string(),
  sceneId: z.string(),
  kind: z
    .enum(['problem', 'todo', 'note'])
    .describe(
      'problem: something wrong; todo: something to add or change; note: a remark or praise.',
    ),
  text: z
    .string()
    .min(1)
    .describe('One point, said plainly, with what would fix it where you can tell.'),
  quote: z
    .string()
    .default('')
    .describe('The words of the scene it is about, when it is about a line or a passage.'),
  status: z.enum(['open', 'done']).default('open'),
  by: z.string().describe('Who left it: "person" or the role of the agent.'),
  createdAt: z.iso.datetime(),
});
export type ScriptNote = z.infer<typeof ScriptNote>;

const notePrefix = (projectId: string): string => `${projectPrefix(projectId)}movie/script-notes/`;

export async function readScriptNotes(
  store: KeyValueStore,
  projectId: string,
): Promise<ScriptNote[]> {
  return (await store.list(notePrefix(projectId)))
    .map((entry) => ScriptNote.safeParse(entry.value))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const ProjectId = z.string().describe('The id of a movie project from project.list.');

export function createScriptNoteCommands(): readonly Command[] {
  const add = defineCommand({
    id: 'movie.script.note.add',
    title: 'Add a script note',
    keywords: ['read-through', 'script notes', 'feedback', 'critique'],
    description:
      'Leaves a note on a scene of the script, as in a read-through: one point per note (problem, todo or note), with the words it is about (quote) where it is about a line. Notes show in Script at once, not as proposals. Read the open ones first with movie.script.note.list and do not repeat them.',
    effect: 'write',
    input: ScriptNote.pick({ sceneId: true, kind: true, text: true }).extend({
      projectId: ProjectId,
      quote: z.string().optional(),
    }),
    output: ScriptNote,
    handler: async ({ actor, runtime }, input) => {
      const id = 'movie.script.note.add';
      await requireProject(runtime.store, id, input.projectId, MODE_ID);
      const scenes = await readScenes(runtime.store, input.projectId);
      if (!scenes.some((scene) => scene.id === input.sceneId)) {
        throw new CommandError('invalid_input', id, `No scene "${input.sceneId}".`);
      }
      const note: ScriptNote = {
        id: runtime.newId(),
        sceneId: input.sceneId,
        kind: input.kind,
        text: input.text,
        quote: input.quote ?? '',
        status: 'open',
        by: actor.kind === 'agent' ? actor.role : 'person',
        createdAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: `${notePrefix(input.projectId)}${note.id}`, value: note },
      ]);
      return note;
    },
  });

  const list = defineCommand({
    id: 'movie.script.note.list',
    title: 'Show the script notes',
    keywords: ['read-through', 'script notes', 'feedback'],
    description:
      'Returns the notes on the script, oldest first: of one scene or all, and only the open ones with open true. Deal with the open notes of a scene when you revise it, and mark each one done with movie.script.note.set.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: z.string().optional(),
      open: z.boolean().default(false),
    }),
    output: z.object({ notes: z.array(ScriptNote) }),
    handler: async ({ runtime }, input) => {
      await requireProject(runtime.store, 'movie.script.note.list', input.projectId, MODE_ID);
      const notes = (await readScriptNotes(runtime.store, input.projectId)).filter(
        (note) =>
          (input.sceneId === undefined || note.sceneId === input.sceneId) &&
          (!input.open || note.status === 'open'),
      );
      return { notes };
    },
  });

  const set = defineCommand({
    id: 'movie.script.note.set',
    title: 'Change a script note',
    description:
      'Marks a script note done (status "done") once the scene deals with it, or open again.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      noteId: z.string(),
      status: z.enum(['open', 'done']),
    }),
    output: ScriptNote,
    handler: async ({ runtime }, input) => {
      const id = 'movie.script.note.set';
      await requireProject(runtime.store, id, input.projectId, MODE_ID);
      const key = `${notePrefix(input.projectId)}${input.noteId}`;
      const stored = ScriptNote.safeParse(await runtime.store.get(key));
      if (!stored.success) {
        throw new CommandError('invalid_input', id, `No script note "${input.noteId}".`);
      }
      const next: ScriptNote = { ...stored.data, status: input.status };
      await runtime.store.batch([{ type: 'put', key, value: next }]);
      return next;
    },
  });

  const remove = defineCommand({
    id: 'movie.script.note.remove',
    title: 'Remove a script note',
    description: 'Removes a script note for good.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, noteId: z.string() }),
    output: z.object({ noteId: z.string() }),
    handler: async ({ runtime }, input) => {
      await requireProject(runtime.store, 'movie.script.note.remove', input.projectId, MODE_ID);
      await runtime.store.batch([
        { type: 'delete', key: `${notePrefix(input.projectId)}${input.noteId}` },
      ]);
      return { noteId: input.noteId };
    },
  });

  return [add, list, set, remove];
}
