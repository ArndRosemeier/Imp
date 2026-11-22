import {
  CommandError,
  defineCommand,
  isInScope,
  listProjects,
  readLanguage,
  readProject,
  type AutoApproval,
  type WriteOperation,
  type Command,
  type CommandRegistry,
  type KeyValueStore,
} from '@imp/core';
import type { ChatMessage, GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import {
  allConversationPrefixes,
  CONVERSATION_MIGRATION_KEY,
  CONVERSATION_PREFIX,
  conversationKey,
  conversationPrefix,
  currentConversationProject,
} from './conversations.js';
import { CrewMember, readCrewMember } from './crew.js';
import type { RoleCatalog } from './role.js';
import { runAgent } from './run.js';
import {
  createWorkCommands,
  releaseInterruptedWork,
  startWork,
  type WorkDescriber,
} from './work.js';

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.json().optional(),
  argumentsText: z.string(),
});

/** One message of a conversation, in the form it is stored in. */
export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string(), context: z.string().optional() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    toolCalls: z.array(ToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    content: z.string(),
    attachments: z.array(z.object({ key: z.string(), mediaType: z.string() })).optional(),
  }),
]);

const UsageSchema = z.object({
  promptTokens: z.number(),
  cachedPromptTokens: z.number(),
  completionTokens: z.number(),
});

const RunStatus = z.enum([
  'completed',
  'awaiting-approval',
  'step-limit',
  'budget-exhausted',
  'cancelled',
  'failed',
]);

const PendingApprovalSchema = z.object({
  id: z.string(),
  commandId: z.string(),
  input: z.json(),
});

/**
 * What a run came to. It leaves the messages out on purpose: an agent that
 * gave another agent a task needs the outcome, not the other's whole context.
 */
export const AgentRunSchema = z.object({
  status: RunStatus,
  finalText: z.string().nullable(),
  steps: z.number(),
  costUsd: z.number(),
  usage: UsageSchema,
  pendingApprovals: z.array(PendingApprovalSchema),
  error: z.string().nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** Everything said and done with one crew member, kept until it is cleared. */
export const ConversationSchema = z.object({
  memberId: z.string(),
  /**
   * The role of the member it was held with. A project moved to another Imp
   * finds its crew under other ids; the member there with the same role takes
   * the conversation over.
   */
  roleId: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  /** What the agent asked for and the user has not decided yet. */
  pendingApprovals: z.array(PendingApprovalSchema),
  /** True while a run is going on. */
  running: z.boolean(),
  /** How the latest run ended, or null before the first one has. */
  lastStatus: RunStatus.nullable(),
  lastError: z.string().nullable(),
  costUsd: z.number(),
  usage: UsageSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

const emptyConversation = (memberId: string): Conversation => ({
  memberId,
  messages: [],
  pendingApprovals: [],
  running: false,
  lastStatus: null,
  lastError: null,
  costUsd: 0,
  usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
});

const storedValue = (conversation: Conversation) =>
  // Through JSON, so optional fields that are undefined are left out.
  z.json().parse(JSON.parse(JSON.stringify(conversation)));

/**
 * A conversation in this project that was held with an agent no longer on the
 * crew, in the same role as `memberId`: what an imported project brings along
 * from the Imp it was exported from. Never one another member already took.
 */
async function orphanFor(
  store: KeyValueStore,
  memberId: string,
  projectId: string | null,
): Promise<{ key: string; conversation: Conversation } | undefined> {
  if (projectId === null) return undefined;
  const member = await readCrewMember(store, memberId);
  if (member === undefined) return undefined;
  for (const entry of await store.list(conversationPrefix(projectId))) {
    const parsed = ConversationSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.roleId !== member.roleId) continue;
    if (parsed.data.memberId === memberId) continue;
    if ((await readCrewMember(store, parsed.data.memberId)) !== undefined) continue;
    return { key: entry.key, conversation: { ...parsed.data, memberId, running: false } };
  }
  return undefined;
}

/** The conversation with a member in a project, or in no project for null. */
async function readConversation(
  store: KeyValueStore,
  memberId: string,
  projectId: string | null,
): Promise<Conversation> {
  const stored = await store.get(conversationKey(memberId, projectId));
  if (stored !== undefined) return ConversationSchema.parse(stored);
  return (await orphanFor(store, memberId, projectId))?.conversation ?? emptyConversation(memberId);
}

/**
 * Like readConversation, for a command that goes on to change it: a
 * conversation taken over from an agent of another Imp is moved to this
 * member's place first, so it is only ever taken over once.
 */
async function claimConversation(
  store: KeyValueStore,
  memberId: string,
  projectId: string | null,
): Promise<Conversation> {
  const stored = await store.get(conversationKey(memberId, projectId));
  if (stored !== undefined) return ConversationSchema.parse(stored);
  const orphan = await orphanFor(store, memberId, projectId);
  if (orphan === undefined) return emptyConversation(memberId);
  await store.batch([
    { type: 'delete', key: orphan.key },
    {
      type: 'put',
      key: conversationKey(memberId, projectId),
      value: storedValue(orphan.conversation),
    },
  ]);
  return orphan.conversation;
}

async function writeConversation(
  store: KeyValueStore,
  conversation: Conversation,
  projectId: string | null,
): Promise<void> {
  await store.batch([
    {
      type: 'put',
      key: conversationKey(conversation.memberId, projectId),
      value: storedValue(conversation),
    },
  ]);
}

function toChatMessages(messages: Conversation['messages']): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content,
        ...(message.context === undefined ? {} : { context: message.context }),
      };
    }
    if (message.role === 'tool') {
      const { attachments, ...rest } = message;
      return attachments === undefined ? rest : { ...rest, attachments };
    }
    if (message.role !== 'assistant') {
      return message;
    }
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
              argumentsText: call.argumentsText,
            })),
          }),
    };
  });
}

const toStored = (messages: readonly ChatMessage[]): Conversation['messages'] =>
  z.array(ChatMessageSchema).parse(JSON.parse(JSON.stringify(messages)));

/**
 * Before conversations were kept per project, every conversation was kept
 * workspace-wide. They were held about the project that was open, so they
 * move into it: the open one, else the one last opened. Without any project
 * they stay workspace-wide. Runs once; a backup from before brings back the
 * old layout without the mark, so loading one moves them again.
 */
async function moveConversationsIntoProjects(store: KeyValueStore): Promise<void> {
  if ((await store.get(CONVERSATION_MIGRATION_KEY)) !== undefined) return;
  let target = await currentConversationProject(store);
  if (target === null) {
    const recent = (await listProjects(store)).sort((a, b) =>
      (b.openedAt ?? b.createdAt).localeCompare(a.openedAt ?? a.createdAt),
    )[0];
    target = recent?.id ?? null;
  }
  const operations: WriteOperation[] = [];
  let moved = 0;
  if (target !== null) {
    for (const entry of await store.list(CONVERSATION_PREFIX)) {
      const parsed = ConversationSchema.safeParse(entry.value);
      if (!parsed.success) continue;
      const member = await readCrewMember(store, parsed.data.memberId);
      const key = conversationKey(parsed.data.memberId, target);
      if ((await store.get(key)) === undefined) {
        operations.push({
          type: 'put',
          key,
          value: storedValue({
            ...parsed.data,
            ...(member === undefined ? {} : { roleId: member.roleId }),
          }),
        });
        moved += 1;
      }
      operations.push({ type: 'delete', key: entry.key });
    }
  }
  operations.push({
    type: 'put',
    key: CONVERSATION_MIGRATION_KEY,
    value: { projectId: target, moved },
  });
  await store.batch(operations);
}

/**
 * Gets conversations ready when a host starts or a backup was loaded: moves
 * those from before conversations were per project, and clears the "working"
 * mark of every conversation, since a run that was going on when the host
 * stopped is not going on any more.
 */
export async function releaseInterruptedRuns(store: KeyValueStore): Promise<void> {
  await moveConversationsIntoProjects(store);
  await releaseInterruptedWork(store, new Date().toISOString());
  for (const prefix of await allConversationPrefixes(store)) {
    const operations: WriteOperation[] = [];
    for (const entry of await store.list(prefix)) {
      const parsed = ConversationSchema.safeParse(entry.value);
      if (!parsed.success || !parsed.data.running) continue;
      operations.push({
        type: 'put',
        key: entry.key,
        value: storedValue({ ...parsed.data, running: false, lastStatus: 'cancelled' }),
      });
    }
    if (operations.length > 0) await store.batch(operations);
  }
}

/** Where the commands the user always allows agents to run are kept. Not a setting: agents can change settings. */
export const ALWAYS_ALLOW_KEY = 'approvals/always-allow';
const AlwaysAllowSchema = z.object({ commandIds: z.array(z.string()) });

async function readAlwaysAllowed(store: KeyValueStore): Promise<string[]> {
  const parsed = AlwaysAllowSchema.safeParse(await store.get(ALWAYS_ALLOW_KEY));
  return parsed.success ? parsed.data.commandIds : [];
}

/**
 * Lets an agent run a command the user said to always allow, as if they had
 * approved it. For the registry's autoApprove hook.
 */
export const alwaysAllowed: AutoApproval = async ({ runtime }, command) =>
  !NEVER_ALWAYS.has(command.id) && (await readAlwaysAllowed(runtime.store)).includes(command.id);

/** Commands that ask every time: an agent that may raise its own budget needs no approval at all. */
const NEVER_ALWAYS: ReadonlySet<string> = new Set(['spend.allowance.set']);

/** One request waiting for the user, with who asked for it. */
export const WaitingApprovalSchema = z.object({
  memberId: z.string(),
  memberName: z.string(),
  approvalId: z.string(),
  commandId: z.string(),
  /** The command's title, or its id when it no longer exists. */
  title: z.string(),
  effect: z.enum(['read', 'write', 'spend', 'destructive']).nullable(),
  input: z.json(),
});
export type WaitingApproval = z.infer<typeof WaitingApprovalSchema>;
/** Commands with which an agent can open a project: the setting is how project.open works. */
const OPENS_PROJECT: ReadonlySet<string> = new Set([
  'project.open',
  'project.create',
  'settings.set',
]);

export interface AgentCommandOptions {
  /** The registry the agents act through. It is also where these commands get registered. */
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
  readonly roles: RoleCatalog;
  /** What the modes add to the work board: stages and the names of things. */
  readonly work?: WorkDescriber;
}

/**
 * Giving an agent work, reading the conversation and deciding on what it
 * asked for are commands too, so the UI has no private way to run an agent,
 * and one agent can give work to another.
 */
export function createAgentCommands(options: AgentCommandOptions): readonly Command[] {
  const { registry, provider, roles, work } = options;
  /**
   * Which project each working agent is working in. An agent works on one
   * thing at a time: while it works in one project it cannot start in another.
   */
  const working = new Map<string, string | null>();

  async function resolve(commandId: string, store: KeyValueStore, memberId: string) {
    const member = await readCrewMember(store, memberId);
    if (member === undefined) {
      throw new CommandError('invalid_input', commandId, `No crew member "${memberId}".`);
    }
    const role = await roles.find(store, member.roleId);
    if (role === undefined) {
      throw new CommandError(
        'invalid_input',
        commandId,
        `The role "${member.roleId}" of ${member.name} is no longer available.`,
      );
    }
    return { member, role };
  }

  const ask = defineCommand({
    id: 'crew.ask',
    title: 'Give an agent a task',
    description:
      'Runs a crew member on a task and returns what it said and what is waiting for approval. The agent remembers the earlier conversation with it. Without a task, it continues where it stopped, such as after a run that was interrupted or reached its step limit. Costs model usage.',
    effect: 'spend',
    input: z.object({
      memberId: z.string().describe('The id of a crew member from crew.list.'),
      task: z
        .string()
        .min(1)
        .optional()
        .describe('What the agent should do, in plain language, with everything it needs to know.'),
      context: z
        .string()
        .optional()
        .describe('Facts the agent should know for this run, such as the current project id.'),
      maxSteps: z.number().int().positive().max(50).default(20),
    }),
    output: AgentRunSchema,
    estimate: async ({ runtime }, input) => {
      const member = await readCrewMember(runtime.store, input.memberId);
      if (member === undefined) return null;
      return { kind: 'chat', model: member.model, maxUsd: member.budgetUsdPerRun };
    },
    handler: async ({ actor, runtime }, input) => {
      const { store } = runtime;
      if (actor.kind === 'agent' && actor.id === input.memberId) {
        throw new CommandError('invalid_input', 'crew.ask', 'An agent cannot give itself a task.');
      }
      const { member, role } = await resolve('crew.ask', store, input.memberId);
      // Fixed for the whole run: the person may open another project meanwhile.
      const projectId = await currentConversationProject(store);
      const elsewhere = working.get(member.id);
      if (elsewhere !== undefined && elsewhere !== projectId) {
        const project = elsewhere === null ? undefined : await readProject(store, elsewhere);
        throw new CommandError(
          'invalid_input',
          'crew.ask',
          `${member.name} is still working ${project === undefined ? 'outside any project' : `in "${project.name}"`}. Wait until it is done.`,
        );
      }
      const before = await claimConversation(store, member.id, projectId);
      if (before.running) {
        throw new CommandError('invalid_input', 'crew.ask', `${member.name} is already working.`);
      }
      if (before.pendingApprovals.length > 0) {
        throw new CommandError(
          'invalid_input',
          'crew.ask',
          `${member.name} is waiting for a decision on what it asked for.`,
        );
      }
      // A run that was cut off ends on the task or on results the model has not seen yet.
      const last = before.messages.at(-1)?.role;
      if (input.task === undefined && last !== 'user' && last !== 'tool') {
        throw new CommandError(
          'invalid_input',
          'crew.ask',
          `${member.name} has nothing to continue. Give it a task.`,
        );
      }

      // The project the agent works in, always: an agent that is given work by another agent
      // was once left to guess the project id, and wrote to none.
      const open = projectId === null ? undefined : await readProject(store, projectId);
      const facts =
        open === undefined
          ? undefined
          : `Open project: "${open.name}" (projectId "${open.id}", mode ${open.mode}).`;
      const runContext =
        facts === undefined || input.context?.includes(open?.id ?? '') === true
          ? input.context
          : [input.context, facts].filter((part) => part !== undefined).join('\n');

      let conversation: Conversation = {
        ...before,
        roleId: member.roleId,
        running: true,
        lastError: null,
      };
      working.set(member.id, projectId);
      const tracker = await startWork(
        {
          store,
          registry,
          describer: work,
          now: () => runtime.now().toISOString(),
          newId: runtime.newId,
        },
        { member, role, projectId, task: input.task ?? null, actor, maxSteps: input.maxSteps },
      );
      let finished = false;
      // Where the conversation is kept. A run that opens a project itself, such as a whole film
      // made from one prompt on the start screen, moves there with it, so that the chat and what
      // waits for approval are where the person now looks. When the person opens another
      // project meanwhile, the run stays where it began.
      let home = projectId;
      let opened = false;
      const save = async (next: Conversation): Promise<void> => {
        const from = home;
        const now = opened ? await currentConversationProject(store) : home;
        if (
          now !== null &&
          now !== home &&
          (await store.get(conversationKey(member.id, now))) === undefined
        ) {
          home = now;
          working.set(member.id, now);
          await tracker.moveTo(now);
        }
        await store.batch([
          ...(from === home
            ? []
            : [{ type: 'delete' as const, key: conversationKey(member.id, from) }]),
          { type: 'put', key: conversationKey(member.id, home), value: storedValue(next) },
        ]);
      };
      try {
        const result = await runAgent({
          registry,
          provider,
          member,
          role,
          blobs: runtime.blobs,
          language: await readLanguage(store),
          onCommand: (id) => {
            if (OPENS_PROJECT.has(id)) opened = true;
          },
          history: toChatMessages(before.messages),
          maxSteps: input.maxSteps,
          ...(input.task === undefined ? {} : { task: input.task }),
          ...(runContext === undefined ? {} : { context: runContext }),
          onProgress: async (messages) => {
            conversation = { ...conversation, messages: toStored(messages) };
            await save(conversation);
          },
          onStep: (step) => tracker.step(step),
        });
        finished = true;
        await tracker.finish({
          status: result.status,
          summary: result.finalText,
          error: result.error,
          costUsd: result.costUsd,
          steps: result.steps,
        });
        const pendingApprovals = result.pendingApprovals.map((pending) => ({
          id: runtime.newId(),
          commandId: pending.commandId,
          input: z.json().parse(pending.input ?? null),
        }));
        conversation = {
          memberId: member.id,
          roleId: member.roleId,
          messages: toStored(result.messages),
          pendingApprovals,
          running: false,
          lastStatus: result.status,
          lastError: result.error,
          costUsd: before.costUsd + result.costUsd,
          usage: {
            promptTokens: before.usage.promptTokens + result.usage.promptTokens,
            cachedPromptTokens: before.usage.cachedPromptTokens + result.usage.cachedPromptTokens,
            completionTokens: before.usage.completionTokens + result.usage.completionTokens,
          },
        };
        return {
          status: result.status,
          finalText: result.finalText,
          steps: result.steps,
          costUsd: result.costUsd,
          usage: result.usage,
          pendingApprovals,
          error: result.error,
        };
      } finally {
        // Also after an unexpected failure, so the agent is never left marked as working.
        working.delete(member.id);
        await save({ ...conversation, running: false });
        if (!finished) {
          await tracker.finish({
            status: 'failed',
            summary: null,
            error: 'The run stopped unexpectedly.',
          });
        }
      }
    },
  });

  const conversationGet = defineCommand({
    id: 'crew.conversation.get',
    title: 'Read conversation',
    description:
      'Returns the conversation with a crew member in the open project: the messages, what is waiting for approval and what it has cost. Every project has its own conversations; with no project open, agents talk in a workspace-wide one.',
    effect: 'read',
    input: z.object({ memberId: z.string() }),
    output: ConversationSchema.extend({
      projectId: z
        .string()
        .nullable()
        .describe('The project the conversation belongs to, or null for the workspace-wide one.'),
    }),
    handler: async ({ runtime }, { memberId }) => {
      const projectId = await currentConversationProject(runtime.store);
      return { ...(await readConversation(runtime.store, memberId, projectId)), projectId };
    },
  });

  const conversationClear = defineCommand({
    id: 'crew.conversation.clear',
    title: 'Clear chat',
    description:
      'Forgets the conversation with a crew member (the coordinator included) in the open project, so its next task there starts fresh. Conversations in other projects and what the agent made are kept. Not while the agent is working.',
    effect: 'destructive',
    input: z.object({ memberId: z.string() }),
    output: z.object({ memberId: z.string(), projectId: z.string().nullable() }),
    handler: async ({ runtime }, { memberId }) => {
      const { store } = runtime;
      const projectId = await currentConversationProject(store);
      const conversation = await readConversation(store, memberId, projectId);
      if (conversation.running) {
        throw new CommandError(
          'invalid_input',
          'crew.conversation.clear',
          'The agent is working. Stop it or wait until it is done.',
        );
      }
      const orphan = await orphanFor(store, memberId, projectId);
      await store.batch([
        { type: 'delete', key: conversationKey(memberId, projectId) },
        ...(orphan === undefined ? [] : [{ type: 'delete' as const, key: orphan.key }]),
      ]);
      return { memberId, projectId };
    },
  });

  const approve = defineCommand({
    id: 'crew.approve',
    title: 'Decide on an agent action',
    description:
      'Approves or declines something an agent asked for and was not allowed to run by itself. The outcome is added to the conversation, and the agent goes on with crew.ask. Only the user can decide.',
    effect: 'write',
    input: z.object({
      memberId: z.string(),
      approvalId: z.string().describe('The id of a pending approval from the conversation.'),
      approve: z.boolean().default(true).describe('False declines the action.'),
    }),
    output: z.object({
      commandId: z.string(),
      approved: z.boolean(),
      output: z.json(),
      /** How many more of this agent's requests are waiting. */
      remaining: z.number(),
    }),
    handler: async ({ actor, runtime }, input) => {
      if (actor.kind !== 'user') {
        // Without this an agent with write access could approve its own spending.
        throw new CommandError('denied', 'crew.approve', 'Only the user can approve an action.');
      }
      const { store } = runtime;
      const { member, role } = await resolve('crew.approve', store, input.memberId);
      const projectId = await currentConversationProject(store);
      const conversation = await claimConversation(store, member.id, projectId);
      const pending = conversation.pendingApprovals.find(({ id }) => id === input.approvalId);
      if (pending === undefined) {
        throw new CommandError(
          'invalid_input',
          'crew.approve',
          `Nothing is waiting under "${input.approvalId}".`,
        );
      }

      let output: z.infer<ReturnType<typeof z.json>> = null;
      let outcome: string;
      if (!input.approve) {
        outcome = 'The user declined this. Do not ask for it again unless they bring it up.';
      } else if (
        !registry.has(pending.commandId) ||
        !isInScope(registry.get(pending.commandId), role.scope)
      ) {
        // An approval lets a command in the role's scope run; it never widens the scope.
        throw new CommandError(
          'denied',
          'crew.approve',
          `"${pending.commandId}" is not a command ${member.name} can run.`,
        );
      } else {
        try {
          const result = await registry.executeById(pending.commandId, pending.input, {
            actor: { kind: 'agent', id: member.id, role: role.id },
            approved: true,
          });
          output = z
            .json()
            .parse(JSON.parse(JSON.stringify(result.status === 'ok' ? result.output : null)));
          outcome = `The user approved it and it ran. Result: ${JSON.stringify(output)}`;
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          outcome = `The user approved it, but it failed: ${error.message}`;
        }
      }

      // Read again: the approved command may itself have changed this conversation.
      const latest = await readConversation(store, member.id, projectId);
      const remaining = latest.pendingApprovals.filter(({ id }) => id !== pending.id);
      await writeConversation(
        store,
        {
          ...latest,
          pendingApprovals: remaining,
          messages: [
            ...latest.messages,
            {
              role: 'user',
              content: `${input.approve ? 'Approved' : 'Declined'}: ${pending.commandId}`,
              context: `This is about your request to run ${pending.commandId} with ${JSON.stringify(pending.input)}. ${outcome}`,
            },
          ],
        },
        projectId,
      );
      return {
        commandId: pending.commandId,
        approved: input.approve,
        output,
        remaining: remaining.length,
      };
    },
  });

  const approvalsList = defineCommand({
    id: 'crew.approvals.list',
    title: 'List waiting approvals',
    description:
      'Returns everything any crew member asked for in the open project that waits for the user to approve or decline, with who asked. The user decides with crew.approve.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ approvals: z.array(WaitingApprovalSchema) }),
    handler: async ({ runtime }) => {
      const { store } = runtime;
      const projectId = await currentConversationProject(store);
      const crew = (await store.list('crew/')).flatMap((entry) => {
        const parsed = CrewMember.safeParse(entry.value);
        return parsed.success ? [parsed.data] : [];
      });
      const approvals: WaitingApproval[] = [];
      for (const member of crew) {
        const conversation = await readConversation(store, member.id, projectId);
        for (const pending of conversation.pendingApprovals) {
          const command = registry.has(pending.commandId)
            ? registry.get(pending.commandId)
            : undefined;
          approvals.push({
            memberId: member.id,
            memberName: member.name,
            approvalId: pending.id,
            commandId: pending.commandId,
            title: command?.title ?? pending.commandId,
            effect: command?.effect ?? null,
            input: pending.input,
          });
        }
      }
      return { approvals };
    },
  });

  const AlwaysAllowed = z.object({
    commands: z.array(
      z.object({
        commandId: z.string(),
        title: z.string(),
        effect: z.enum(['read', 'write', 'spend', 'destructive']).nullable(),
      }),
    ),
  });
  const describeAllowed = (commandIds: readonly string[]) => ({
    commands: commandIds.map((commandId) => {
      const command = registry.has(commandId) ? registry.get(commandId) : undefined;
      return {
        commandId,
        title: command?.title ?? commandId,
        effect: command?.effect ?? null,
      };
    }),
  });

  const alwaysList = defineCommand({
    id: 'crew.approvals.always.list',
    title: 'List always-allowed actions',
    description:
      'Returns the commands the user lets agents run without asking, although they spend or delete.',
    effect: 'read',
    input: z.object({}),
    output: AlwaysAllowed,
    handler: async ({ runtime }) => describeAllowed(await readAlwaysAllowed(runtime.store)),
  });

  const alwaysSet = defineCommand({
    id: 'crew.approvals.always.set',
    title: 'Always allow an action',
    description:
      'Lets agents run one command without asking first from now on, or makes them ask again. Only the user can change this.',
    effect: 'write',
    input: z.object({
      commandId: z.string().min(1),
      allow: z.boolean().default(true).describe('False makes agents ask again.'),
    }),
    output: AlwaysAllowed,
    handler: async ({ actor, runtime }, { commandId, allow }) => {
      if (actor.kind !== 'user') {
        // Otherwise an agent could let itself spend without asking.
        throw new CommandError(
          'denied',
          'crew.approvals.always.set',
          'Only the user can decide what agents may do without asking.',
        );
      }
      if (allow && NEVER_ALWAYS.has(commandId)) {
        throw new CommandError(
          'invalid_input',
          'crew.approvals.always.set',
          'Changing the budget without approval always asks you first.',
        );
      }
      if (allow && !registry.has(commandId)) {
        throw new CommandError(
          'invalid_input',
          'crew.approvals.always.set',
          `No command "${commandId}".`,
        );
      }
      const current = await readAlwaysAllowed(runtime.store);
      const next = allow
        ? [...new Set([...current, commandId])]
        : current.filter((id) => id !== commandId);
      await runtime.store.batch([
        { type: 'put', key: ALWAYS_ALLOW_KEY, value: { commandIds: next } },
      ]);
      return describeAllowed(next);
    },
  });

  return [
    ask,
    approve,
    conversationGet,
    conversationClear,
    approvalsList,
    alwaysList,
    alwaysSet,
    ...createWorkCommands(),
  ];
}
