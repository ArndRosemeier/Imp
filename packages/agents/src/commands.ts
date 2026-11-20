import {
  CommandError,
  defineCommand,
  type Command,
  type CommandRegistry,
  type KeyValueStore,
} from '@imp/core';
import type { ChatMessage, GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import { readCrewMember } from './crew.js';
import type { RoleCatalog } from './role.js';
import { runAgent } from './run.js';

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.json().optional(),
  argumentsText: z.string(),
});

/** The conversation of a run, in a form that can be stored and sent back to continue it. */
export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    toolCalls: z.array(ToolCallSchema).optional(),
  }),
  z.object({ role: z.literal('tool'), toolCallId: z.string(), content: z.string() }),
]);

const PendingApprovalSchema = z.object({ commandId: z.string(), input: z.json() });

export const AgentRunSchema = z.object({
  status: z.enum([
    'completed',
    'awaiting-approval',
    'step-limit',
    'budget-exhausted',
    'cancelled',
    'failed',
  ]),
  finalText: z.string().nullable(),
  steps: z.number(),
  costUsd: z.number(),
  pendingApprovals: z.array(PendingApprovalSchema),
  messages: z.array(ChatMessageSchema),
  error: z.string().nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

function toChatMessages(messages: readonly z.infer<typeof ChatMessageSchema>[]): ChatMessage[] {
  return messages.map((message) => {
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

export interface AgentCommandOptions {
  /** The registry the agents act through. It is also where these commands get registered. */
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
  readonly roles: RoleCatalog;
}

/**
 * Giving an agent work and approving what it asked for are commands too, so
 * the UI has no private way to run an agent.
 */
export function createAgentCommands(options: AgentCommandOptions): readonly Command[] {
  const { registry, provider, roles } = options;

  async function resolve(commandId: string, store: KeyValueStore, memberId: string) {
    const member = await readCrewMember(store, memberId);
    if (member === undefined) {
      throw new CommandError('invalid_input', commandId, `No crew member "${memberId}".`);
    }
    const role = roles.get(member.roleId);
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
      'Runs a crew member on a task and returns what it did, what it said and what is waiting for approval. Costs model usage.',
    effect: 'spend',
    input: z.object({
      memberId: z.string().describe('The id of a crew member from crew.list.'),
      task: z.string().min(1).describe('What the agent should do, in plain language.'),
      history: z
        .array(ChatMessageSchema)
        .default([])
        .describe('The messages of an earlier run with this agent, to continue it.'),
      maxSteps: z.number().int().positive().max(50).default(20),
    }),
    output: AgentRunSchema,
    handler: async ({ runtime }, input) => {
      const { member, role } = await resolve('crew.ask', runtime.store, input.memberId);
      const result = await runAgent({
        registry,
        provider,
        member,
        role,
        task: input.task,
        history: toChatMessages(input.history),
        maxSteps: input.maxSteps,
      });
      return AgentRunSchema.parse(JSON.parse(JSON.stringify(result)));
    },
  });

  const approve = defineCommand({
    id: 'crew.approve',
    title: 'Approve an agent action',
    description:
      'Runs a command an agent asked for and was not allowed to run by itself. Only the user can approve.',
    effect: 'write',
    input: z.object({
      memberId: z.string(),
      commandId: z.string().describe('The command the agent asked to run.'),
      input: z.json().describe('The input the agent asked to run it with.'),
    }),
    output: z.object({ commandId: z.string(), output: z.json() }),
    handler: async ({ actor, runtime }, input) => {
      if (actor.kind !== 'user') {
        // Without this an agent with write access could approve its own spending.
        throw new CommandError('denied', 'crew.approve', 'Only the user can approve an action.');
      }
      const { member, role } = await resolve('crew.approve', runtime.store, input.memberId);
      const result = await registry.executeById(input.commandId, input.input, {
        actor: { kind: 'agent', id: member.id, role: role.id },
        approved: true,
      });
      return {
        commandId: input.commandId,
        output: z.json().parse(result.status === 'ok' ? (result.output ?? null) : null),
      };
    },
  });

  return [ask, approve];
}
