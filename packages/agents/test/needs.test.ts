import {
  CommandRegistry,
  CURRENT_PROJECT_SETTING,
  defineCommand,
  projectCreate,
  settingsCommands,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentRunSchema,
  coordinatorRole,
  createAgentCommands,
  createCrewCommands,
  createModelCommands,
  createNeedCommands,
  RoleCatalog,
  type Role,
} from '../src/index.js';

/**
 * A small story mode: the caster makes the cast, the writer writes scenes for
 * it, and the designer can do nothing at all without a cast.
 */
const CAST_KEY = 'story/cast';
const hasCast = async (store: { get: (key: string) => Promise<unknown> }) =>
  (await store.get(CAST_KEY)) !== undefined;

const castNeed = {
  id: 'cast',
  name: 'A cast',
  description: 'The characters.',
  providedBy: 'caster',
  check: (store: Parameters<typeof hasCast>[0]) => hasCast(store),
};

const writer: Role = {
  id: 'writer',
  name: 'Writer',
  summary: 'Writes scenes.',
  brief: 'You write scenes.',
  scope: { prefixes: ['story.'], writes: ['story.scene.'] },
  sees: [],
  needs: [{ ...castNeed, before: ['story.scene.write'] }],
};
const caster: Role = {
  id: 'caster',
  name: 'Caster',
  summary: 'Makes the cast.',
  brief: 'You cast.',
  scope: { prefixes: ['story.'], writes: ['story.cast.'] },
  sees: ['image'],
  mustSee: ['image'],
};
const designer: Role = {
  id: 'designer',
  name: 'Designer',
  summary: 'Designs.',
  brief: 'You design.',
  scope: { prefixes: ['story.'], writes: ['story.design.'] },
  needs: [castNeed],
};

const write = (id: string) =>
  defineCommand({
    id,
    title: id,
    description: `Changes the story: ${id}, for tests of who may do it.`,
    effect: 'write',
    input: z.object({ text: z.string().default('') }),
    output: z.object({ done: z.boolean() }),
    handler: async ({ runtime }, { text }) => {
      if (id === 'story.cast.add')
        await runtime.store.batch([{ type: 'put', key: CAST_KEY, value: text }]);
      return { done: true };
    },
  });

const look = defineCommand({
  id: 'story.look',
  title: 'Look at a picture',
  description: 'Shows the picture of the story to the agent, so it can judge it.',
  effect: 'read',
  input: z.object({}),
  output: z.object({ attachments: z.array(z.object({ key: z.string(), mediaType: z.string() })) }),
  handler: () => Promise.resolve({ attachments: [{ key: 'pic', mediaType: 'image/png' }] }),
});

const user = { kind: 'user', id: 'arnd' } as const;
const model = (id: string, input: readonly ('text' | 'image')[], tools = true) => ({
  id,
  name: id,
  inputModalities: input,
  outputModalities: ['text' as const],
  supportsTools: tools,
  contextLength: null,
  pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
});

async function setup(replies: ScriptedChatReply[] = []) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({
    replies,
    models: [model('text/only', ['text']), model('sees/pictures', ['text', 'image'])],
  });
  const roles = new RoleCatalog([coordinatorRole, writer, caster, designer]);
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    projectCreate,
    write('story.scene.write'),
    write('story.cast.add'),
    write('story.design.make'),
    look,
    ...createCrewCommands(roles, { models: () => provider.listModels() }),
    ...createNeedCommands(roles),
    ...createModelCommands(provider, roles),
    ...createAgentCommands({ registry, provider, roles }),
  );
  const run = async (
    id: string,
    input: unknown,
    actor: { kind: 'user' | 'agent'; id: string; role?: string } = user,
  ) => {
    const first = await registry.executeById(id, input, { actor: actor as never });
    // What an agent asks for is put to the person, who approves it here.
    const result =
      first.status === 'needs-approval'
        ? await registry.executeById(id, input, { actor: actor as never, approved: true })
        : first;
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);
    return result.output;
  };
  const project = (await run('project.create', { name: 'Tale', mode: 'story' })) as { id: string };
  await run('settings.set', { key: CURRENT_PROJECT_SETTING, value: project.id });
  const hire = async (roleId: string, modelId = 'sees/pictures') =>
    (await run('crew.hire', { roleId, model: modelId })) as { id: string };
  return { runtime, registry, provider, run, hire, projectId: project.id };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args as never,
  argumentsText: JSON.stringify(args),
});

describe('what roles need', () => {
  it('says what each role needs, and lets a project go without it', async () => {
    const { run } = await setup();
    const needs = (await run('crew.needs', { roleId: 'designer' })) as {
      roles: { ready: boolean; needs: { id: string; state: string; providedBy: string }[] }[];
    };
    expect(needs.roles[0]).toMatchObject({
      ready: false,
      needs: [{ id: 'cast', state: 'missing', providedBy: 'caster' }],
    });
    // A need for some commands only leaves the role ready for the rest.
    expect(await run('crew.needs', { roleId: 'writer' })).toMatchObject({
      roles: [{ ready: true, needs: [{ state: 'missing', before: ['story.scene.write'] }] }],
    });
    await run('story.cast.add', { text: 'Ada' });
    expect(await run('crew.needs', { roleId: 'designer' })).toMatchObject({
      roles: [{ ready: true, needs: [{ state: 'met' }] }],
    });
    await expect(run('crew.needs', { roleId: 'nobody' })).rejects.toThrow(/Unknown role/);
    await expect(run('crew.needs.waive', { need: 'plot' })).rejects.toThrow(/No role needs/);
  });

  it('keeps an agent from giving a task while a need is missing, unless it names it', async () => {
    const { run, hire } = await setup([{ content: 'Development written.' }]);
    const coordinator = await hire('coordinator', 'text/only');
    const writing = await hire('writer', 'text/only');
    const asCoordinator = { kind: 'agent', id: coordinator.id, role: 'coordinator' } as const;
    await expect(
      run('crew.ask', { memberId: writing.id, task: 'Write scene one.' }, asCoordinator),
    ).rejects.toThrow(/cannot start yet\. Missing: A cast \(made by the Caster\)/);
    // Named as not needed for this task, it goes ahead, and the member is told what is missing.
    const done = AgentRunSchema.parse(
      await run(
        'crew.ask',
        { memberId: writing.id, task: 'Write only the development.', without: ['cast'] },
        asCoordinator,
      ),
    );
    expect(done.status).toBe('completed');
  });

  it('lets a project go without a need for good', async () => {
    const { run, hire, provider } = await setup([{ content: 'Designed.' }]);
    const coordinator = await hire('coordinator', 'text/only');
    const designing = await hire('designer');
    await run('crew.needs.waive', { need: 'cast', reason: 'Nobody is in this film.' });
    const asCoordinator = { kind: 'agent', id: coordinator.id, role: 'coordinator' } as const;
    await run('crew.ask', { memberId: designing.id, task: 'Design it.' }, asCoordinator);
    expect(provider.requests[0]?.messages[1]).toMatchObject({
      context: expect.stringContaining(
        'this project goes without it (Nobody is in this film.)',
      ) as string,
    });
    await run('crew.needs.waive', { need: 'cast', waived: false });
    await expect(
      run('crew.ask', { memberId: designing.id, task: 'Again.' }, asCoordinator),
    ).rejects.toThrow(/cannot start yet/);
  });

  it('stops a crew member at the commands a missing need is for, and takes its report', async () => {
    const { run, hire, provider, runtime } = await setup([
      { toolCalls: [toolCall('c1', 'story__scene__write', { text: 'INT. HALL' })] },
      {
        toolCalls: [
          toolCall('c2', 'report_missing', {
            what: 'A cast',
            from: 'caster',
            detail: 'Scene one needs its characters.',
          }),
        ],
      },
    ]);
    const writing = await hire('writer', 'text/only');
    // A person may give the task; the member is told what is missing.
    const result = AgentRunSchema.parse(
      await run('crew.ask', { memberId: writing.id, task: 'Write scene one.' }),
    );
    expect(result.status).toBe('blocked');
    expect(result.missing).toEqual({
      what: 'A cast',
      from: 'caster',
      detail: 'Scene one needs its characters.',
    });
    expect(result.finalText).toContain('Missing: A cast (work of caster).');
    // The scene was never written: the command was refused with what to do instead.
    const refused = provider.requests[1]?.messages.at(-1);
    expect(refused).toMatchObject({ role: 'tool' });
    expect((refused as { content: string }).content).toMatch(/needs A cast.*report_missing/);
    expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toContain(
      'report_missing',
    );
    // It writes only its own area and is never given a command that shows pictures.
    const tools = provider.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).toContain('story__scene__write');
    expect(tools).not.toContain('story__cast__add');
    expect(tools).not.toContain('story__look');
    expect(await runtime.store.get(CAST_KEY)).toBeUndefined();
  });

  it('never lets the coordinator report, since it arranges what is missing', async () => {
    const { run, hire, provider } = await setup([{ content: 'Hello.' }]);
    const coordinator = await hire('coordinator', 'text/only');
    await run('crew.ask', { memberId: coordinator.id, task: 'Hi.' });
    const tools = provider.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).not.toContain('report_missing');
    expect(tools).not.toContain('story__scene__write');
  });
});

describe('models that fit a role', () => {
  it('hires only a model that can do the work, and lists only those', async () => {
    const { run, hire } = await setup();
    await expect(hire('caster', 'text/only')).rejects.toThrow(
      /The Caster needs a model that takes pictures as input; text\/only does not/,
    );
    const casting = await hire('caster', 'sees/pictures');
    await expect(run('crew.update', { id: casting.id, model: 'text/only' })).rejects.toThrow(
      /takes pictures/,
    );
    // A model the catalog does not know is let through.
    await run('crew.update', { id: casting.id, model: 'somewhere/new' });
    // The writer works from text, so any model with tools fits.
    await hire('writer', 'text/only');
    const ids = async (role: string) =>
      ((await run('models.list', { role })) as { models: { id: string }[] }).models.map(
        (listed) => listed.id,
      );
    expect(await ids('caster')).toEqual(['sees/pictures']);
    expect(await ids('writer')).toEqual(['sees/pictures', 'text/only']);
    await expect(run('models.list', { role: 'nobody' })).rejects.toThrow(/Unknown role/);
    expect(await run('crew.role.get', { id: 'caster' })).toMatchObject({
      modelInput: ['image'],
      writes: ['story.cast.'],
      sees: ['image'],
    });
  });
});
