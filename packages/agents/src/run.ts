import {
  CommandError,
  fromToolName,
  isInScope,
  toToolDefinitions,
  type Actor,
  type CommandRegistry,
} from '@imp/core';
import {
  ProviderError,
  type CancelSignal,
  type ChatMessage,
  type GenerationProvider,
  type ToolCall,
} from '@imp/providers';
import type { CrewMember } from './crew.js';
import type { Role } from './role.js';

export interface PendingApproval {
  readonly commandId: string;
  readonly input: unknown;
}

export type AgentRunStatus =
  /** The agent said it was finished. */
  | 'completed'
  /** The agent stopped because something it needs is waiting for the user's approval. */
  | 'awaiting-approval'
  | 'step-limit'
  | 'budget-exhausted'
  | 'cancelled'
  /** The provider failed in a way the run could not continue from. */
  | 'failed';

export interface AgentRunResult {
  readonly status: AgentRunStatus;
  /** The agent's last message to the user, if it wrote one. */
  readonly finalText: string | null;
  readonly steps: number;
  readonly costUsd: number;
  readonly pendingApprovals: readonly PendingApproval[];
  /** The whole conversation, so a run can be shown, audited or resumed. */
  readonly messages: readonly ChatMessage[];
  readonly error: string | null;
}

export interface AgentRunOptions {
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
  readonly member: CrewMember;
  readonly role: Role;
  /** What the agent is asked to do in this run. */
  readonly task: string;
  /** Facts for this run, such as the current project, added to the agent's instructions. */
  readonly context?: string;
  /** Earlier messages to continue from, without the system message. */
  readonly history?: readonly ChatMessage[];
  /** The most model calls this run may make. */
  readonly maxSteps?: number;
  readonly signal?: CancelSignal;
}

const DEFAULT_MAX_STEPS = 20;

function systemPrompt(member: CrewMember, role: Role, context: string | undefined): string {
  return [
    `You are ${member.name}, working as ${role.name} in Imp, a content creation toolbox.`,
    role.brief,
    ...(context === undefined ? [] : [`Context for this run:\n${context}`]),
    'You act only by calling the tools you are given. Read the current state before changing it.',
    'If a tool reports that it needs approval, do not call it again; finish and say what is waiting.',
    'When the task is done, reply with a short summary of what you did.',
  ].join('\n\n');
}

/**
 * Runs one agent on one task: ask the model, execute the commands it calls,
 * feed the results back, and repeat until it finishes or hits a limit. The
 * agent acts through the same registry and policy as everyone else.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { registry, provider, member, role } = options;
  const actor: Actor = { kind: 'agent', id: member.id, role: role.id };
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const tools = toToolDefinitions(registry.list(), role.scope);

  const messages: ChatMessage[] = [
    ...(options.history ?? []),
    { role: 'user', content: options.task },
  ];
  const pendingApprovals: PendingApproval[] = [];
  let costUsd = 0;
  let steps = 0;
  let finalText: string | null = null;

  const finish = (status: AgentRunStatus, error: string | null = null): AgentRunResult => ({
    status,
    finalText,
    steps,
    costUsd,
    pendingApprovals,
    messages,
    error,
  });

  async function execute(call: ToolCall): Promise<string> {
    const commandId = fromToolName(call.name);
    if (!registry.has(commandId) || !isInScope(registry.get(commandId), role.scope)) {
      return JSON.stringify({ error: `"${call.name}" is not a tool you have.` });
    }
    if (call.arguments === undefined) {
      return JSON.stringify({ error: 'The arguments were not valid JSON. Call the tool again.' });
    }
    try {
      const result = await registry.executeById(commandId, call.arguments, { actor });
      if (result.status === 'needs-approval') {
        pendingApprovals.push({ commandId, input: result.input });
        return JSON.stringify({
          status: 'needs-approval',
          note: 'The user must approve this before it runs. It has been put in front of them.',
        });
      }
      return JSON.stringify({ status: 'ok', output: result.output });
    } catch (error) {
      if (error instanceof CommandError) {
        return JSON.stringify({ error: error.message, details: error.details });
      }
      throw error;
    }
  }

  while (steps < maxSteps) {
    if (options.signal?.aborted === true) {
      return finish('cancelled');
    }
    if (costUsd >= member.budgetUsdPerRun) {
      return finish('budget-exhausted');
    }

    steps += 1;
    let response;
    try {
      response = await provider.chat(
        {
          model: member.model,
          messages: [
            { role: 'system', content: systemPrompt(member, role, options.context) },
            ...messages,
          ],
          tools,
        },
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        return finish('failed', error.message);
      }
      throw error;
    }
    costUsd += response.usage.costUsd ?? 0;
    messages.push({
      role: 'assistant',
      content: response.content,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    });

    if (response.toolCalls.length === 0) {
      finalText = response.content;
      return finish(pendingApprovals.length > 0 ? 'awaiting-approval' : 'completed');
    }
    for (const call of response.toolCalls) {
      messages.push({ role: 'tool', toolCallId: call.id, content: await execute(call) });
    }
  }
  return finish('step-limit');
}
