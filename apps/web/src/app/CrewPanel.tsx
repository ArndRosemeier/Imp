import { AgentRunSchema, ConversationSchema, type AgentRun, type CrewMember } from '@imp/agents';
import { fromToolName } from '@imp/core';
import {
  BroomIcon,
  CheckIcon,
  PaperPlaneRightIcon,
  WrenchIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { RichText } from './RichText.js';

const STATUS_NOTE: Partial<Record<AgentRun['status'], string>> = {
  'step-limit': 'Stopped at the step limit. Say "continue" to go on.',
  'budget-exhausted': 'Stopped because the budget for one run is used up.',
  cancelled: 'The last run was interrupted.',
};

function outcomeOf(content: string): string {
  try {
    const parsed = JSON.parse(content) as { status?: string; error?: string };
    return parsed.error !== undefined ? `failed: ${parsed.error}` : (parsed.status ?? 'done');
  } catch {
    return 'done';
  }
}

/** What a tool call did, named by the command behind it. */
function actionOf(call: { name: string; arguments?: unknown }): string {
  if (call.name === 'run_command') {
    const id = (call.arguments as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : 'run_command';
  }
  return call.name === 'find_commands' ? 'looked up commands' : fromToolName(call.name);
}

/** What an agent asks to run, in words where possible and never hiding a value. */
function ApprovalRequest({
  commandId,
  input,
}: {
  commandId: string;
  input: unknown;
}): ReactElement {
  const imp = useImp();
  const crew = useLive(['crew/'], async (current) =>
    z
      .object({ crew: z.array(z.object({ id: z.string(), name: z.string() })) })
      .parse(await runCommand(current, 'crew.list', {})),
  );
  const title = imp.commands.find((command) => command.id === commandId)?.title ?? commandId;
  const fields =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.entries(input)
      : [['input', input] as const];
  const show = (key: string, value: unknown): string => {
    if (key === 'memberId') {
      return crew.data?.crew.find((member) => member.id === value)?.name ?? String(value);
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return (
    <>
      <div>
        <strong>{title}</strong> <span className="mono muted">{commandId}</span>
      </div>
      <dl className="request">
        {fields.map(([key, value]) => (
          <div key={key}>
            <dt>{key === 'memberId' ? 'crew member' : key}</dt>
            <dd>{show(key, value)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/**
 * The conversation with one crew member, with what it did and what it asks
 * approval for. Everything shown is read from the store, so it survives a
 * reload and updates while the agent works.
 */
export function CrewPanel({
  member,
  context,
  hidden = false,
}: {
  member: CrewMember;
  /** What the agent should know about where the user is, sent with every message. */
  context: string;
  hidden?: boolean;
}): ReactElement {
  const imp = useImp();
  const live = useLive([`conversations/${member.id}`], async (current) =>
    ConversationSchema.parse(
      await runCommand(current, 'crew.conversation.get', { memberId: member.id }),
    ),
  );
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const inputId = useId();

  const conversation = live.data;
  const messages = conversation?.messages ?? [];
  const approvals = conversation?.pendingApprovals ?? [];
  const working = busy || conversation?.running === true;
  const note =
    problem ??
    live.error ??
    (conversation?.lastStatus === 'failed'
      ? conversation.lastError
      : conversation?.lastStatus
        ? (STATUS_NOTE[conversation.lastStatus] ?? null)
        : null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, approvals.length, working]);

  const ask = (task?: string): void => {
    setBusy(true);
    setProblem(null);
    runCommand(imp, 'crew.ask', { memberId: member.id, context, ...(task ? { task } : {}) })
      .then((output) => AgentRunSchema.parse(output))
      .catch((reason: unknown) => {
        setProblem(messageOf(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const send = (event: SyntheticEvent): void => {
    event.preventDefault();
    const task = draft.trim();
    if (task === '' || working || approvals.length > 0) return;
    setDraft('');
    ask(task);
  };

  const settle = (approvalId: string, approve: boolean): void => {
    setBusy(true);
    setProblem(null);
    runCommand(imp, 'crew.approve', { memberId: member.id, approvalId, approve }).then(
      (output) => {
        // Once everything is decided, the agent goes on with the outcomes.
        if ((output as { remaining: number }).remaining === 0) ask();
        else setBusy(false);
      },
      (reason: unknown) => {
        setProblem(messageOf(reason));
        setBusy(false);
      },
    );
  };

  const cached =
    conversation !== undefined && conversation.usage.promptTokens > 0
      ? Math.round((100 * conversation.usage.cachedPromptTokens) / conversation.usage.promptTokens)
      : 0;

  return (
    <aside className="crew-panel" aria-label={`Conversation with ${member.name}`} hidden={hidden}>
      <div className="crew-head stack">
        <div className="row spread">
          <h2>{member.name}</h2>
          <span
            className="mono muted"
            title={`Spent in this conversation. ${String(cached)}% of what was sent came from cache.`}
          >
            ${(conversation?.costUsd ?? 0).toFixed(4)}
          </span>
        </div>
        <div className="row spread">
          <span className="mono muted">{member.model}</span>
          {messages.length > 0 && (
            <button
              className="button quiet small"
              disabled={working}
              onClick={() => {
                runCommand(imp, 'crew.conversation.clear', { memberId: member.id }).catch(
                  (reason: unknown) => {
                    setProblem(messageOf(reason));
                  },
                );
              }}
            >
              <BroomIcon aria-hidden="true" /> Start over
            </button>
          )}
        </div>
      </div>
      <div className="thread" aria-live="polite">
        {messages.length === 0 && (
          <p className="muted">
            Tell {member.name} what you want to make or set up. It acts through the same commands
            you have, and asks before spending.
          </p>
        )}
        {messages.map((message, index) => {
          if (message.role === 'user') {
            return (
              <div key={index} className="bubble" data-from="user">
                {message.content}
              </div>
            );
          }
          if (message.role === 'assistant') {
            return (
              <div key={index} className="stack">
                {message.content !== null && message.content !== '' && (
                  <div className="bubble" data-from="agent">
                    <RichText text={message.content} />
                  </div>
                )}
                {(message.toolCalls ?? []).map((call) => {
                  const result = messages.find(
                    (candidate) => candidate.role === 'tool' && candidate.toolCallId === call.id,
                  );
                  return (
                    <div key={call.id} className="action-line mono">
                      <WrenchIcon aria-hidden="true" />
                      {actionOf(call)}
                      {result?.role === 'tool' && <span>· {outcomeOf(result.content)}</span>}
                    </div>
                  );
                })}
              </div>
            );
          }
          return null;
        })}
        {working && <p className="muted">Working</p>}
        {!working &&
          approvals.map((approval) => (
            <section key={approval.id} className="approval" aria-label="Needs your approval">
              <span className="eyebrow">Needs your approval</span>
              <ApprovalRequest commandId={approval.commandId} input={approval.input} />
              <div className="row">
                <button
                  className="button primary"
                  onClick={() => {
                    settle(approval.id, true);
                  }}
                >
                  <CheckIcon aria-hidden="true" /> Approve
                </button>
                <button
                  className="button"
                  onClick={() => {
                    settle(approval.id, false);
                  }}
                >
                  <XIcon aria-hidden="true" /> Decline
                </button>
              </div>
            </section>
          ))}
        {!working && note !== null && (
          <p className="error" role="status">
            {note}
          </p>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor={inputId}>
          Message to {member.name}
        </label>
        <textarea
          id={inputId}
          className="input"
          rows={3}
          placeholder={
            approvals.length > 0 ? 'Decide on the request above first' : `Ask ${member.name}`
          }
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.currentTarget.form?.requestSubmit();
              event.preventDefault();
            }
          }}
        />
        <button
          className="button primary"
          disabled={working || approvals.length > 0 || draft.trim() === ''}
        >
          Send <PaperPlaneRightIcon aria-hidden="true" />
        </button>
      </form>
    </aside>
  );
}
