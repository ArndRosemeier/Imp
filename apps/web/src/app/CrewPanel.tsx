import { AgentRunSchema, type AgentRun, type CrewMember } from '@imp/agents';
import { fromToolName } from '@imp/core';
import { CheckIcon, PaperPlaneRightIcon, WrenchIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { messageOf, runCommand, useImp } from './context.js';
import { RichText } from './RichText.js';

type Messages = AgentRun['messages'];
type Approval = AgentRun['pendingApprovals'][number] & { readonly key: string };

const STATUS_NOTE: Partial<Record<AgentRun['status'], string>> = {
  'step-limit': 'Stopped at the step limit. Say "continue" to go on.',
  'budget-exhausted': 'Stopped because the budget for one run is used up.',
  cancelled: 'Cancelled.',
};

function outcomeOf(content: string): string {
  try {
    const parsed = JSON.parse(content) as { status?: string; error?: string };
    return parsed.error !== undefined ? `failed: ${parsed.error}` : (parsed.status ?? 'done');
  } catch {
    return 'done';
  }
}

/** The conversation with one crew member, with what it did and what it asks approval for. */
export function CrewPanel({
  member,
  context,
  hidden = false,
}: {
  member: CrewMember;
  /** What the agent should know about where the user is, sent with every message. */
  context: string;
  /** A hidden panel keeps its conversation while the user talks to someone else. */
  hidden?: boolean;
}): ReactElement {
  const imp = useImp();
  const [messages, setMessages] = useState<Messages>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [spent, setSpent] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, approvals, busy]);

  const send = (event: SyntheticEvent): void => {
    event.preventDefault();
    const task = draft.trim();
    if (task === '' || busy) return;
    setDraft('');
    setBusy(true);
    setNote(null);
    const history = messages;
    setMessages([...history, { role: 'user', content: task }]);
    runCommand(imp, 'crew.ask', { memberId: member.id, task, history, context }).then(
      (output) => {
        const run = AgentRunSchema.parse(output);
        setMessages(run.messages);
        setSpent((total) => total + run.costUsd);
        setApprovals((current) => [
          ...current,
          ...run.pendingApprovals.map((approval) => ({ ...approval, key: crypto.randomUUID() })),
        ]);
        setNote(run.status === 'failed' ? run.error : (STATUS_NOTE[run.status] ?? null));
        setBusy(false);
      },
      (reason: unknown) => {
        setNote(messageOf(reason));
        setBusy(false);
      },
    );
  };

  const settle = (approval: Approval, approve: boolean): void => {
    const drop = (): void => {
      setApprovals((current) => current.filter((candidate) => candidate.key !== approval.key));
    };
    if (!approve) {
      drop();
      return;
    }
    runCommand(imp, 'crew.approve', {
      memberId: member.id,
      commandId: approval.commandId,
      input: approval.input,
    }).then(drop, (reason: unknown) => {
      setNote(messageOf(reason));
    });
  };

  return (
    <aside className="crew-panel" aria-label={`Conversation with ${member.name}`} hidden={hidden}>
      <div className="crew-head stack">
        <div className="row spread">
          <h2>{member.name}</h2>
          <span className="mono muted" title="Spent in this conversation">
            ${spent.toFixed(4)}
          </span>
        </div>
        <span className="mono muted">{member.model}</span>
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
                      {fromToolName(call.name)}
                      {result?.role === 'tool' && <span>· {outcomeOf(result.content)}</span>}
                    </div>
                  );
                })}
              </div>
            );
          }
          return null;
        })}
        {busy && <p className="muted">Working</p>}
        {approvals.map((approval) => (
          <section key={approval.key} className="approval" aria-label="Needs your approval">
            <span className="eyebrow">Needs your approval</span>
            <span className="mono">{approval.commandId}</span>
            <pre>{JSON.stringify(approval.input, null, 2)}</pre>
            <div className="row">
              <button
                className="button primary"
                onClick={() => {
                  settle(approval, true);
                }}
              >
                <CheckIcon aria-hidden="true" /> Approve
              </button>
              <button
                className="button"
                onClick={() => {
                  settle(approval, false);
                }}
              >
                <XIcon aria-hidden="true" /> Decline
              </button>
            </div>
          </section>
        ))}
        {note !== null && (
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
          placeholder={`Ask ${member.name}`}
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
        <button className="button primary" disabled={busy || draft.trim() === ''}>
          Send <PaperPlaneRightIcon aria-hidden="true" />
        </button>
      </form>
    </aside>
  );
}
