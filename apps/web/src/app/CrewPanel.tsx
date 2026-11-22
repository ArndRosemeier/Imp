import {
  AgentRunSchema,
  conversationKey,
  ConversationSchema,
  type AgentRun,
  type CrewMember,
} from '@imp/agents';
import { fromToolName, READY_REPORT_KEY, ReadyReport } from '@imp/core';
import {
  BroomIcon,
  BugIcon,
  CheckIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  StampIcon,
  WrenchIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { z } from 'zod';
import { setAttachment, useAttachment } from './attachment.js';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { ASK_COORDINATOR } from './help/help.js';
import {
  ApprovalRequest,
  CONTINUE_AGENT,
  openApprovals,
  useWaitingApprovals,
} from './Approvals.js';
import { ImpSpinner } from './ImpMark.js';
import { RichText } from './RichText.js';
import { servedByLocalServer } from '../host/served.js';
import { t, tx } from '../i18n/i18n.js';

const STATUS_NOTE: Partial<Record<AgentRun['status'], string>> = {
  get 'step-limit'(): string {
    return t('Stopped at the step limit.');
  },
  get 'budget-exhausted'(): string {
    return t('Stopped because the budget for one run is used up.');
  },
  get cancelled(): string {
    return t('The last run was interrupted, for example because the tab was closed or reloaded.');
  },
};

/** Runs that stopped part way, which Continue picks up where they left off. */
/** The conversation shown, with the project it belongs to (null outside projects). */
const ConversationWhere = ConversationSchema.extend({ projectId: z.string().nullable() });

const CONTINUABLE: ReadonlySet<string> = new Set(['step-limit', 'cancelled']);

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
  return call.name === 'find_commands' ? t('looked up commands') : fromToolName(call.name);
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
  intro,
  takesSuggestions = false,
}: {
  member: CrewMember;
  /** What the agent should know about where the user is, sent with every message. */
  context: string;
  hidden?: boolean;
  /** Shown before the first message, in place of the usual words. It can fill in the message box. */
  intro?: (suggest: (text: string) => void) => ReactNode;
  /** Fills the message box when another view suggests what to ask, as the guided path does. */
  takesSuggestions?: boolean;
}): ReactElement {
  const imp = useImp();
  // Every project has its own conversation with each agent. The one shown
  // follows the open project; the core says which project that is.
  const [shownProject, setShownProject] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const live = useLive(
    [
      'settings/project.current',
      conversationKey(member.id, null),
      ...(shownProject === null ? [] : [conversationKey(member.id, shownProject)]),
    ],
    async (current) =>
      ConversationWhere.parse(
        await runCommand(current, 'crew.conversation.get', { memberId: member.id }),
      ),
  );
  const liveProject = live.data?.projectId ?? null;
  if (liveProject !== shownProject) {
    // Another project was opened: follow its conversation, and drop a question about the last one.
    setShownProject(liveProject);
    setClearing(false);
  }
  // A problem report this agent prepared opens from a button: retold, its long link gets cut.
  const ready = useLive([READY_REPORT_KEY], async (current) =>
    z
      .object({ report: ReadyReport.nullable() })
      .parse(await runCommand(current, 'support.report.ready', {})),
  );
  const report = ready.data?.report?.memberId === member.id ? ready.data.report : null;
  const dismissReport = (): void => {
    runCommand(imp, 'support.report.dismiss', {}).catch(() => undefined);
  };
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const attachment = useAttachment();

  const conversation = live.data;
  const messages = conversation?.messages ?? [];
  const approvals = conversation?.pendingApprovals ?? [];
  const everyone = useWaitingApprovals().data ?? [];
  const elsewhere = everyone.filter((item) => item.memberId !== member.id).length;
  const working = busy || conversation?.running === true;
  const note =
    problem ??
    live.error ??
    (conversation?.lastStatus === 'failed'
      ? conversation.lastError
      : conversation?.lastStatus
        ? (STATUS_NOTE[conversation.lastStatus] ?? null)
        : null);

  // In the browser the agents run in this tab, so leaving it stops them.
  const inTab = !servedByLocalServer();
  const lastRole = messages.at(-1)?.role;
  const canContinue =
    !working &&
    approvals.length === 0 &&
    CONTINUABLE.has(conversation?.lastStatus ?? '') &&
    (lastRole === 'user' || lastRole === 'tool');

  useEffect(() => {
    if (!takesSuggestions) return;
    const onSuggest = (event: Event): void => {
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text !== 'string') return;
      setDraft(text);
      // After the panel has been shown, so the focus lands.
      window.setTimeout(() => {
        document.getElementById(inputId)?.focus();
      }, 0);
    };
    window.addEventListener(ASK_COORDINATOR, onSuggest);
    return () => {
      window.removeEventListener(ASK_COORDINATOR, onSuggest);
    };
  }, [takesSuggestions, inputId]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, approvals.length, working]);

  useEffect(() => {
    if (!working || !inTab) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [working, inTab]);

  const ask = (task?: string, about?: string): void => {
    setBusy(true);
    setProblem(null);
    runCommand(imp, 'crew.ask', {
      memberId: member.id,
      context: about === undefined ? context : `${context}\n${about}`,
      ...(task ? { task } : {}),
    })
      .then((output) => AgentRunSchema.parse(output))
      .catch((reason: unknown) => {
        setProblem(messageOf(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // The approvals dialog decided everything this agent asked for: it goes on.
  const continueRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    continueRef.current = () => {
      if (!working) ask();
    };
  });
  useEffect(() => {
    const onContinue = (event: Event): void => {
      if ((event as CustomEvent<unknown>).detail === member.id) continueRef.current();
    };
    window.addEventListener(CONTINUE_AGENT, onContinue);
    return () => {
      window.removeEventListener(CONTINUE_AGENT, onContinue);
    };
  }, [member.id]);

  const send = (event: SyntheticEvent): void => {
    event.preventDefault();
    const task = draft.trim();
    if (task === '' || working || approvals.length > 0) return;
    setDraft('');
    if (attachment === null) {
      ask(task);
      return;
    }
    // A marked stretch of a scene makes the message a request about it, kept with the proposal.
    setBusy(true);
    runCommand(imp, 'movie.edit.request', {
      projectId: attachment.projectId,
      sceneId: attachment.sceneId,
      fromSeconds: attachment.fromSeconds,
      toSeconds: attachment.toSeconds,
      instruction: task,
    }).then(
      (output) => {
        ask(task, z.object({ context: z.string() }).parse(output).context);
      },
      (reason: unknown) => {
        setProblem(messageOf(reason));
        setBusy(false);
      },
    );
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
    <aside
      className="crew-panel"
      aria-label={t('Conversation with {name}', { name: tx(member.name) })}
      hidden={hidden}
    >
      <div className="crew-head stack">
        <div className="row spread">
          <h2>{tx(member.name)}</h2>
          <span
            className="mono muted"
            title={t('Spent in this conversation. {cached}% of what was sent came from cache.', {
              cached: String(cached),
            })}
          >
            {formatUsd(conversation?.costUsd ?? 0, 4)}
          </span>
        </div>
        <div className="row spread">
          <span className="mono muted">{member.model}</span>
          {messages.length > 0 && !clearing && (
            <button
              type="button"
              className="button quiet small"
              disabled={working}
              title={
                liveProject === null
                  ? t('Forget this chat. Chats in projects are kept.')
                  : t('Forget this chat in this project. Chats in other projects are kept.')
              }
              onClick={() => {
                setClearing(true);
              }}
            >
              <BroomIcon aria-hidden="true" /> {t('Clear chat')}
            </button>
          )}
        </div>
        {clearing && (
          <div className="row clear-chat" role="group" aria-label={t('Clear this chat?')}>
            <span className="muted">
              {liveProject === null
                ? t('Forget everything said with {name} outside projects?', {
                    name: tx(member.name),
                  })
                : t('Forget everything said with {name} in this project?', {
                    name: tx(member.name),
                  })}
            </span>
            <button
              type="button"
              className="button danger small"
              disabled={working}
              onClick={() => {
                setClearing(false);
                runCommand(imp, 'crew.conversation.clear', { memberId: member.id }).catch(
                  (reason: unknown) => {
                    setProblem(messageOf(reason));
                  },
                );
              }}
            >
              {t('Clear')}
            </button>
            <button
              type="button"
              className="button quiet small"
              onClick={() => {
                setClearing(false);
              }}
            >
              {t('Keep')}
            </button>
          </div>
        )}
      </div>
      <div className="thread" aria-live="polite">
        {messages.length === 0 &&
          (intro?.((text) => {
            setDraft(text);
            document.getElementById(inputId)?.focus();
          }) ?? (
            <p className="muted">
              {t(
                'Tell {name} what you want to make or set up. It acts through the same commands you have, and asks before spending or deleting.',
                { name: tx(member.name) },
              )}
            </p>
          ))}
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
        {working && (
          <p className="muted crew-working" role="status">
            <ImpSpinner /> {t('{name} is on it', { name: tx(member.name) })}
            {inTab && (
              <span className="small">
                {' '}
                {t(
                  '· Keep this tab open while {name} works. Closing or reloading it stops the run, and you can continue it afterwards.',
                  { name: tx(member.name) },
                )}
              </span>
            )}
          </p>
        )}
        {!working &&
          approvals.map((approval) => (
            <section key={approval.id} className="approval" aria-label={t('Needs your approval')}>
              <span className="eyebrow">{t('Needs your approval')}</span>
              <ApprovalRequest
                commandId={approval.commandId}
                title={tx(
                  imp.commands.find((command) => command.id === approval.commandId)?.title ??
                    approval.commandId,
                )}
                input={approval.input}
              />
              <div className="row">
                <button
                  className="button primary"
                  onClick={() => {
                    settle(approval.id, true);
                  }}
                >
                  <CheckIcon aria-hidden="true" /> {t('Approve')}
                </button>
                <button
                  className="button"
                  onClick={() => {
                    settle(approval.id, false);
                  }}
                >
                  <XIcon aria-hidden="true" /> {t('Decline')}
                </button>
              </div>
            </section>
          ))}
        {report !== null && (
          <section className="approval" aria-label={t('Problem report')}>
            <span className="eyebrow">{t('Problem report ready')}</span>
            <p>{report.title}</p>
            <div className="row">
              <a
                className="button primary"
                href={report.url}
                target="_blank"
                rel="noreferrer"
                onClick={dismissReport}
              >
                <BugIcon aria-hidden="true" /> {t('Check and submit on GitHub')}
              </a>
              <button className="button" onClick={dismissReport}>
                <XIcon aria-hidden="true" /> {t('Dismiss')}
              </button>
            </div>
          </section>
        )}
        {!working && note !== null && (
          <p className="error" role="status">
            {note}
          </p>
        )}
        {canContinue && (
          <button
            type="button"
            className="button small continue-run"
            onClick={() => {
              ask();
            }}
          >
            <PlayIcon aria-hidden="true" />{' '}
            {t('Continue where {name} stopped', { name: tx(member.name) })}
          </button>
        )}
        <div ref={end} />
      </div>
      {!working && everyone.length > 1 && (approvals.length > 0 || elsewhere > 0) && (
        <button
          type="button"
          className="approvals-banner"
          aria-haspopup="dialog"
          onClick={openApprovals}
        >
          <StampIcon aria-hidden="true" size={20} />
          <span className="stack">
            <strong>{t('Review all {count} requests at once', { count: everyone.length })}</strong>
            <span className="muted small">
              {elsewhere > 0 && approvals.length === 0
                ? t('Other crew members are waiting on you.')
                : elsewhere > 0
                  ? t('{elsewhere} of them from other crew members.', {
                      elsewhere: String(elsewhere),
                    })
                  : t('Approve or decline them together.')}
            </span>
          </span>
        </button>
      )}
      <form className="composer" onSubmit={send}>
        {attachment !== null && (
          <div className="attached">
            <PaperclipIcon aria-hidden="true" />
            <span>
              {t('About')} <strong>{attachment.label}</strong>
            </span>
            <button
              type="button"
              className="button quiet icon"
              aria-label={t('Do not attach the marked stretch')}
              onClick={() => {
                setAttachment(null);
              }}
            >
              <XIcon aria-hidden="true" />
            </button>
          </div>
        )}
        <label className="sr-only" htmlFor={inputId}>
          {t('Message to {name}', { name: tx(member.name) })}
        </label>
        <textarea
          id={inputId}
          className="input"
          rows={3}
          placeholder={
            approvals.length > 0
              ? t('Decide on the request above first')
              : attachment !== null
                ? t('What should {name} do with this stretch?', { name: tx(member.name) })
                : t('Ask {name}', { name: tx(member.name) })
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
          {t('Send')} <PaperPlaneRightIcon aria-hidden="true" />
        </button>
      </form>
    </aside>
  );
}
