import {
  CommandError,
  defineCommand,
  isInScope,
  type Command,
  type CommandRegistry,
  type KeyValueStore,
} from '@imp/core';
import type { ChatMessage, GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import { CONVERSATION_PREFIX, readCrewMember } from './crew.js';
import type { RoleCatalog } from './role.js';
import { runAgent } from './run.js';

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
  z.object({ role: z.literal('tool'), toolCallId: z.string(), content: z.string() }),
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

async function readConversation(store: KeyValueStore, memberId: string): Promise<Conversation> {
  const stored = await store.get(`${CONVERSATION_PREFIX}${memberId}`);
  return stored === undefined ? emptyConversation(memberId) : ConversationSchema.parse(stored);
}

async function writeConversation(store: KeyValueStore, conversation: Conversation): Promise<void> {
  await store.batch([
    {
      type: 'put',
      key: `${CONVERSATION_PREFIX}${conversation.memberId}`,
      // Through JSON, so optional fields that are undefined are left out.
      value: z.json().parse(JSON.parse(JSON.stringify(conversation))),
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
 * Clears the "working" mark of every conversation. A host calls this once at
 * start-up: a run that was going on when the host stopped is not going on any more.
 */
export async function releaseInterruptedRuns(store: KeyValueStore): Promise<void> {
  const stale = (await store.list(CONVERSATION_PREFIX))
    .map((entry) => ConversationSchema.parse(entry.value))
    .filter((conversation) => conversation.running);
  for (const conversation of stale) {
    await writeConversation(store, {
      ...conversation,
      running: false,
      lastStatus: 'cancelled',
    });
  }
}

export interface AgentCommandOptions {
  /** The registry the agents act through. It is also where these commands get registered. */
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
  readonly roles: RoleCatalog;
}

/**
 * Giving an agent work, reading the conversation and deciding on what it
 * asked for are commands too, so the UI has no private way to run an agent,
 * and one agent can give work to another.
 */
export function createAgentCommands(options: AgentCommandOptions): readonly Command[] {
  const { registry, provider, roles } = options;

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
      'Runs a crew member on a task and returns what it said and what is waiting for approval. The agent remembers the earlier conversation with it. Without a task, it continues where it stopped. Costs model usage.',
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
    handler: async ({ actor, runtime }, input) => {
      const { store } = runtime;
      if (actor.kind === 'agent' && actor.id === input.memberId) {
        throw new CommandError('invalid_input', 'crew.ask', 'An agent cannot give itself a task.');
      }
      const { member, role } = await resolve('crew.ask', store, input.memberId);
      const before = await readConversation(store, member.id);
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
      if (input.task === undefined && before.messages.at(-1)?.role !== 'user') {
        throw new CommandError(
          'invalid_input',
          'crew.ask',
          `${member.name} has nothing to continue. Give it a task.`,
        );
      }

      let conversation: Conversation = { ...before, running: true, lastError: null };
      try {
        const result = await runAgent({
          registry,
          provider,
          member,
          role,
          history: toChatMessages(before.messages),
          maxSteps: input.maxSteps,
          ...(input.task === undefined ? {} : { task: input.task }),
          ...(input.context === undefined ? {} : { context: input.context }),
          onProgress: async (messages) => {
            conversation = { ...conversation, messages: toStored(messages) };
            await writeConversation(store, conversation);
          },
        });
        const pendingApprovals = result.pendingApprovals.map((pending) => ({
          id: runtime.newId(),
          commandId: pending.commandId,
          input: z.json().parse(pending.input ?? null),
        }));
        conversation = {
          memberId: member.id,
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
        await writeConversation(store, { ...conversation, running: false });
      }
    },
  });

  const conversationGet = defineCommand({
    id: 'crew.conversation.get',
    title: 'Read conversation',
    description:
      'Returns the conversation with a crew member: the messages, what is waiting for approval and what it has cost.',
    effect: 'read',
    input: z.object({ memberId: z.string() }),
    output: ConversationSchema,
    handler: ({ runtime }, { memberId }) => readConversation(runtime.store, memberId),
  });

  const conversationClear = defineCommand({
    id: 'crew.conversation.clear',
    title: 'Clear conversation',
    description:
      'Forgets the conversation with a crew member, so the next task starts fresh. What the agent made is kept.',
    effect: 'destructive',
    input: z.object({ memberId: z.string() }),
    output: z.object({ memberId: z.string() }),
    handler: async ({ runtime }, { memberId }) => {
      await runtime.store.batch([{ type: 'delete', key: `${CONVERSATION_PREFIX}${memberId}` }]);
      return { memberId };
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
      const conversation = await readConversation(store, member.id);
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
      const latest = await readConversation(store, member.id);
      const remaining = latest.pendingApprovals.filter(({ id }) => id !== pending.id);
      await writeConversation(store, {
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
      });
      return {
        commandId: pending.commandId,
        approved: input.approve,
        output,
        remaining: remaining.length,
      };
    },
  });

  return [ask, approve, conversationGet, conversationClear];
}
