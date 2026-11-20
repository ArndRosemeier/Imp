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
import {
  describeGroups,
  discoveryTools,
  findCommands,
  FIND_TOOL,
  isDirect,
  RUN_TOOL,
} from './discovery.js';
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
  /** Token counts over the whole run. Cached tokens are part of the prompt tokens. */
  readonly usage: {
    readonly promptTokens: number;
    readonly cachedPromptTokens: number;
    readonly completionTokens: number;
  };
  readonly pendingApprovals: readonly PendingApproval[];
  /**
   * The conversation, to show and to continue from. Long tool results are
   * dropped from it: they were used, and what ran is in the activity log.
   */
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
/** Tool results longer than this are not carried into the next run. */
const KEPT_RESULT_CHARS = 1200;
const TRIMMED_RESULT = JSON.stringify({
  status: 'ok',
  trimmed: true,
  note: 'This result was dropped to save context. Call the tool again if you need it.',
});

/**
 * The instructions hold nothing that changes between requests, so that they
 * and the tool definitions stay cached for the whole conversation.
 */
function systemPrompt(member: CrewMember, role: Role, hiddenGroups: string | null): string {
  return [
    `You are ${member.name}, working as ${role.name} in Imp, a content creation toolbox.`,
    role.brief,
    'You act only by calling the tools you are given. Read the current state before changing it.',
    ...(hiddenGroups === null
      ? []
      : [
          `You can run more commands than you have tools for. Their groups are: ${hiddenGroups}. Look one up with ${FIND_TOOL} and run it with ${RUN_TOOL}.`,
        ]),
    'If a tool reports that it needs approval, do not call it again; finish and say what is waiting.',
    'When the task is done, reply with a short summary of what you did.',
  ].join('\n\n');
}

/** Marks the last message, so the provider caches the conversation up to it. */
function withCacheMark(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) =>
    index === messages.length - 1 && message.role !== 'assistant'
      ? { ...message, cache: true }
      : message,
  );
}

function withoutLongResults(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.role === 'tool' && message.content.length > KEPT_RESULT_CHARS
      ? { ...message, content: TRIMMED_RESULT }
      : message,
  );
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
  const inScope = registry.list().filter((command) => isInScope(command, role.scope));
  const hidden = inScope.filter((command) => !isDirect(command, role.direct));
  const tools = [
    ...toToolDefinitions(inScope.filter((command) => isDirect(command, role.direct))),
    ...(hidden.length > 0 ? discoveryTools : []),
  ];
  const system: ChatMessage = {
    role: 'system',
    content: systemPrompt(member, role, hidden.length > 0 ? describeGroups(hidden) : null),
    cache: true,
  };

  const messages: ChatMessage[] = [
    ...(options.history ?? []),
    {
      role: 'user',
      content: options.task,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  ];
  const pendingApprovals: PendingApproval[] = [];
  const usage = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
  let costUsd = 0;
  let steps = 0;
  let finalText: string | null = null;

  const finish = (status: AgentRunStatus, error: string | null = null): AgentRunResult => ({
    status,
    finalText,
    steps,
    costUsd,
    usage,
    pendingApprovals,
    messages: withoutLongResults(messages),
    error,
  });

  async function run(commandId: string, input: unknown): Promise<string> {
    if (!registry.has(commandId) || !isInScope(registry.get(commandId), role.scope)) {
      return JSON.stringify({ error: `"${commandId}" is not a command you can run.` });
    }
    try {
      const result = await registry.executeById(commandId, input, { actor });
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

  async function execute(call: ToolCall): Promise<string> {
    if (call.arguments === undefined) {
      return JSON.stringify({ error: 'The arguments were not valid JSON. Call the tool again.' });
    }
    if (hidden.length > 0 && (call.name === FIND_TOOL || call.name === RUN_TOOL)) {
      const given = call.arguments as { query?: unknown; id?: unknown; input?: unknown } | null;
      const text = (value: unknown): string => (typeof value === 'string' ? value : '');
      if (call.name === FIND_TOOL) {
        return JSON.stringify(findCommands(hidden, text(given?.query)));
      }
      return run(text(given?.id), given?.input ?? {});
    }
    return run(fromToolName(call.name), call.arguments);
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
          messages: [system, ...withCacheMark(messages)],
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
    usage.promptTokens += response.usage.promptTokens;
    usage.cachedPromptTokens += response.usage.cachedPromptTokens;
    usage.completionTokens += response.usage.completionTokens;
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
