import { WaitingApprovalSchema, type WaitingApproval } from '@imp/agents';
import {
  CaretDownIcon,
  CheckIcon,
  SealCheckIcon,
  StampIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type SyntheticEvent,
} from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive, type Live } from './context.js';
import { HornedBadge, ImpSpinner } from './ImpMark.js';
import { formatUsd, Price, useEstimate, type Estimate } from './spend.js';

/** Opens the approvals dialog from anywhere, such as an activity view. */
export const OPEN_APPROVALS = 'imp:open-approvals';
/** Asks one crew member's panel to let the agent go on, once all it asked for is decided. */
export const CONTINUE_AGENT = 'imp:continue-agent';

export function openApprovals(): void {
  window.dispatchEvent(new Event(OPEN_APPROVALS));
}

const WaitingList = z.object({ approvals: z.array(WaitingApprovalSchema) });
const AlwaysList = z.object({
  commands: z.array(
    z.object({ commandId: z.string(), title: z.string(), effect: z.string().nullable() }),
  ),
});
const CrewNames = z.object({ crew: z.array(z.object({ id: z.string(), name: z.string() })) });

/** Everything the crew is waiting on in the open project, kept current. */
export function useWaitingApprovals(): Live<readonly WaitingApproval[]> {
  const live = useLive(
    ['crew/', 'conversations/', 'settings/project.current'],
    async (imp) => WaitingList.parse(await runCommand(imp, 'crew.approvals.list', {})).approvals,
  );
  return live;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fields of a request, with crew member ids shown by name and no value ever hidden. */
function useFields(input: unknown): { key: string; label: string; value: string }[] {
  const crew = useLive(['crew/'], async (imp) =>
    CrewNames.parse(await runCommand(imp, 'crew.list', {})),
  );
  const entries: [string, unknown][] = isRecord(input) ? Object.entries(input) : [['input', input]];
  return entries.map(([key, value]) => ({
    key,
    label: key === 'memberId' ? 'crew member' : key,
    value:
      key === 'memberId'
        ? (crew.data?.crew.find((member) => member.id === value)?.name ?? String(value))
        : typeof value === 'string'
          ? value
          : JSON.stringify(value),
  }));
}

/** What an agent asks to run, in words where possible and never hiding a value. */
export function ApprovalRequest({
  commandId,
  title,
  input,
}: {
  commandId: string;
  title: string;
  input: unknown;
}): ReactElement {
  const fields = useFields(input);
  return (
    <>
      <div className="row spread wrap">
        <span>
          <strong>{title}</strong> <span className="mono muted">{commandId}</span>
        </span>
        {isRecord(input) && <Price command={commandId} input={input} />}
      </div>
      <dl className="request">
        {fields.map((field) => (
          <div key={field.key}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** What an approval costs at most, as a number to add up, or null when nobody knows. */
const costOf = (estimate: Estimate | null): number | null =>
  estimate === null
    ? null
    : estimate.basis === 'budget' && estimate.maxUsd !== undefined
      ? estimate.maxUsd
      : estimate.usd;

type Outcome =
  | { state: 'working' }
  | { state: 'approved' }
  | { state: 'declined' }
  | { state: 'failed'; note: string };

const OUTCOME_WORDS: Readonly<Record<Exclude<Outcome['state'], 'failed'>, string>> = {
  working: 'Deciding',
  approved: 'Approved',
  declined: 'Declined',
};

function ApprovalRow({
  item,
  approve,
  onToggle,
  always,
  onAlways,
  outcome,
  locked,
  onCost,
}: {
  item: WaitingApproval;
  approve: boolean;
  onToggle: () => void;
  always: boolean;
  onAlways: (next: boolean) => void;
  outcome: Outcome | undefined;
  locked: boolean;
  onCost: (id: string, usd: number | null) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const fields = useFields(item.input);
  const estimate = useEstimate(item.commandId, isRecord(item.input) ? item.input : {});
  const usd = costOf(estimate);
  useEffect(() => {
    onCost(item.approvalId, usd);
  }, [item.approvalId, usd, onCost]);
  const summary = fields
    .filter((field) => field.key !== 'projectId')
    .slice(0, 2)
    .map((field) => `${field.label}: ${field.value}`)
    .join(' · ');
  const detailsId = `approval-details-${item.approvalId}`;
  const risky = item.effect === 'destructive';
  return (
    <li
      className="approvals-row"
      data-choice={approve ? 'approve' : 'decline'}
      data-outcome={outcome?.state}
    >
      <div className="approvals-row-main">
        <label className="approvals-pick">
          <input
            type="checkbox"
            className="approvals-check"
            checked={approve}
            disabled={locked}
            aria-label={`Approve ${item.title}`}
            onChange={onToggle}
          />
          <span className="approvals-what">
            <span className="approvals-title">
              {item.title}
              {risky && <span className="approvals-effect">deletes</span>}
            </span>
            <span className="approvals-summary">{summary || item.commandId}</span>
          </span>
        </label>
        <div className="approvals-side">
          {outcome === undefined ? (
            isRecord(item.input) && <Price command={item.commandId} input={item.input} />
          ) : outcome.state === 'working' ? (
            <span className="approvals-outcome" role="status">
              <ImpSpinner size={16} /> {OUTCOME_WORDS.working}
            </span>
          ) : outcome.state === 'failed' ? (
            <span className="approvals-outcome" data-state="failed">
              <WarningIcon aria-hidden="true" /> Failed
            </span>
          ) : (
            <span className="approvals-outcome" data-state={outcome.state}>
              {outcome.state === 'approved' ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <XIcon aria-hidden="true" />
              )}
              {OUTCOME_WORDS[outcome.state]}
            </span>
          )}
          <button
            type="button"
            className="button quiet icon approvals-expand"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={
              open ? `Hide the details of ${item.title}` : `Show the details of ${item.title}`
            }
            onClick={() => {
              setOpen(!open);
            }}
          >
            <CaretDownIcon aria-hidden="true" />
          </button>
        </div>
      </div>
      {outcome?.state === 'failed' && <p className="approvals-note error">{outcome.note}</p>}
      <div id={detailsId} className="approvals-details" hidden={!open}>
        <dl className="request">
          <div>
            <dt>command</dt>
            <dd className="mono">{item.commandId}</dd>
          </div>
          {fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {(item.effect === 'spend' || item.effect === 'destructive') && outcome === undefined && (
        <label className="approvals-always" data-on={always}>
          <input
            type="checkbox"
            checked={always}
            disabled={locked || !approve}
            onChange={(event) => {
              onAlways(event.target.checked);
            }}
          />
          <span>
            Always allow <strong>{item.title}</strong>
            <span className="muted">
              {' '}
              {risky
                ? '· agents will delete without asking'
                : '· agents will spend on this without asking'}
            </span>
          </span>
        </label>
      )}
    </li>
  );
}

/**
 * Every request the crew is waiting on, in one place: look each over, see
 * who asked and what it costs, then approve or decline them all at once or
 * one by one. Opens by itself when several requests arrive together.
 */
export function Approvals(): ReactElement {
  const imp = useImp();
  const dialog = useRef<HTMLDialogElement>(null);
  const waiting = useWaitingApprovals();
  const live = waiting.data ?? [];
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [always, setAlways] = useState<ReadonlySet<string>>(new Set());
  const [costs, setCosts] = useState<ReadonlyMap<string, number | null>>(new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [batch, setBatch] = useState<readonly WaitingApproval[] | null>(null);
  const [phase, setPhase] = useState<'review' | 'working' | 'done'>('review');
  const [problem, setProblem] = useState<string | null>(null);
  const seen = useRef<ReadonlySet<string> | null>(null);

  const shown = batch ?? live;
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });
  const locked = phase !== 'review';

  const show = useCallback((): void => {
    if (dialog.current?.open !== true) dialog.current?.showModal();
  }, []);

  const close = useCallback((): void => {
    dialog.current?.close();
  }, []);

  useEffect(() => {
    window.addEventListener(OPEN_APPROVALS, show);
    return () => {
      window.removeEventListener(OPEN_APPROVALS, show);
    };
  }, [show]);

  // Several requests that arrive together open the dialog by itself; ones there at load do not.
  useEffect(() => {
    if (waiting.data === undefined) return;
    const ids = new Set(waiting.data.map((item) => item.approvalId));
    const before = seen.current;
    seen.current = ids;
    if (before === null || phase !== 'review') return;
    const arrived = [...ids].some((id) => !before.has(id));
    if (arrived && ids.size >= 2) show();
  }, [waiting.data, phase, show]);

  // Left alone, the dialog closes when nothing is waiting any more.
  useEffect(() => {
    if (phase === 'review' && waiting.data?.length === 0) close();
  }, [phase, waiting.data, close]);

  const onCost = useCallback((id: string, usd: number | null): void => {
    setCosts((current) => {
      if (current.has(id) && current.get(id) === usd) return current;
      const next = new Map(current);
      next.set(id, usd);
      return next;
    });
  }, []);

  const reset = (): void => {
    setBatch(null);
    setOutcomes(new Map());
    setPhase('review');
    setDeclined(new Set());
    setAlways(new Set());
    setProblem(null);
  };

  const approving = shown.filter((item) => !declined.has(item.approvalId));
  const approvedCount = approving.length;
  const declinedCount = shown.length - approvedCount;
  const known = approving.map((item) => costs.get(item.approvalId) ?? null);
  const total = known.reduce<number>((sum, usd) => sum + (usd ?? 0), 0);
  const unknown = known.some((usd) => usd === null);

  const decide = async (mode: 'all' | 'none' | 'picked'): Promise<void> => {
    const items = [...live];
    if (items.length === 0) return;
    const choices = items.map((item) => ({
      item,
      approve: mode === 'all' ? true : mode === 'none' ? false : !declined.has(item.approvalId),
    }));
    setBatch(items);
    setPhase('working');
    setProblem(null);
    if (mode !== 'picked') {
      setDeclined(mode === 'all' ? new Set() : new Set(items.map((item) => item.approvalId)));
    }
    const mark = (id: string, outcome: Outcome): void => {
      setOutcomes((current) => new Map(current).set(id, outcome));
    };

    // What the user said to always allow counts from now on, these requests included.
    const allowed = [
      ...new Set(
        choices
          .filter(({ item, approve }) => approve && always.has(item.commandId))
          .map(({ item }) => item.commandId),
      ),
    ];
    for (const commandId of allowed) {
      try {
        await runCommand(imp, 'crew.approvals.always.set', { commandId, allow: true });
      } catch (reason) {
        setProblem(messageOf(reason));
      }
    }

    // One agent's requests in the order it asked; different agents side by side.
    const byMember = new Map<string, typeof choices>();
    for (const choice of choices) {
      byMember.set(choice.item.memberId, [...(byMember.get(choice.item.memberId) ?? []), choice]);
    }
    const tally = { failed: false };
    const finished: string[] = [];
    await Promise.all(
      [...byMember].map(async ([memberId, list]) => {
        let remaining = -1;
        for (const { item, approve } of list) {
          mark(item.approvalId, { state: 'working' });
          try {
            const output = z.object({ remaining: z.number() }).parse(
              await runCommand(imp, 'crew.approve', {
                memberId,
                approvalId: item.approvalId,
                approve,
              }),
            );
            remaining = output.remaining;
            mark(item.approvalId, { state: approve ? 'approved' : 'declined' });
          } catch (reason) {
            tally.failed = true;
            mark(item.approvalId, { state: 'failed', note: messageOf(reason) });
          }
        }
        if (remaining === 0) finished.push(memberId);
      }),
    );
    // Once all it asked for is decided, each agent goes on with the outcomes.
    for (const memberId of finished) {
      window.dispatchEvent(new CustomEvent(CONTINUE_AGENT, { detail: memberId }));
    }
    setPhase('done');
    if (!tally.failed) {
      window.setTimeout(() => {
        // What agents asked for meanwhile, such as one given a task just now, is shown next.
        const decided = new Set(items.map((item) => item.approvalId));
        if (latest.current.some((item) => !decided.has(item.approvalId))) reset();
        else close();
      }, 900);
    }
  };

  const toggleAll = (): void => {
    setDeclined(
      declinedCount === 0 ? new Set(shown.map((item) => item.approvalId)) : new Set<string>(),
    );
  };

  const groups = new Map<string, WaitingApproval[]>();
  for (const item of shown) {
    groups.set(item.memberId, [...(groups.get(item.memberId) ?? []), item]);
  }
  const askers = [...new Set(shown.map((item) => item.memberName))];

  const heading =
    phase === 'done'
      ? 'Decided'
      : shown.length === 1
        ? 'One request is waiting'
        : `${String(shown.length)} requests are waiting`;

  const primaryLabel =
    declinedCount === 0
      ? shown.length === 1
        ? 'Approve'
        : `Approve all ${String(shown.length)}`
      : approvedCount === 0
        ? shown.length === 1
          ? 'Decline'
          : `Decline all ${String(shown.length)}`
        : `Approve ${String(approvedCount)} · decline ${String(declinedCount)}`;

  return (
    // A tap on the dimmed backdrop closes the dialog, as Escape does; a tablet has no Escape key.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={dialog}
      className="modal approvals-dialog"
      aria-labelledby="approvals-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && phase !== 'working') close();
      }}
      onCancel={(event: SyntheticEvent) => {
        // Decisions under way finish first.
        if (phase === 'working') event.preventDefault();
      }}
      onClose={() => {
        if (phase !== 'working') reset();
      }}
    >
      <header className="approvals-head">
        <HornedBadge>
          {phase === 'done' ? (
            <SealCheckIcon size={26} aria-hidden="true" />
          ) : (
            <StampIcon size={26} aria-hidden="true" />
          )}
        </HornedBadge>
        <div className="stack approvals-heading">
          <span className="eyebrow">Needs your approval</span>
          <h2 id="approvals-title">{heading}</h2>
          {shown.length > 0 && (
            <span className="muted">
              Asked by {askers.join(', ')}. Agents ask before they spend money or delete anything.
            </span>
          )}
        </div>
        <button
          className="button quiet icon"
          aria-label="Close"
          disabled={phase === 'working'}
          onClick={close}
        >
          <XIcon aria-hidden="true" size={18} />
        </button>
      </header>

      {shown.length > 1 && phase === 'review' && (
        <div className="approvals-toolbar">
          <label className="approvals-pick approvals-all">
            <input
              type="checkbox"
              className="approvals-check"
              checked={declinedCount === 0}
              ref={(element) => {
                if (element !== null) {
                  element.indeterminate = declinedCount > 0 && approvedCount > 0;
                }
              }}
              onChange={toggleAll}
            />
            <span>
              {approvedCount} of {shown.length} picked to approve
            </span>
          </label>
          <span className="muted small">Unpicked requests are declined.</span>
        </div>
      )}

      <div className="approvals-body">
        {waiting.error !== null && <p className="error">{waiting.error}</p>}
        {shown.length === 0 && waiting.data !== undefined && (
          <p className="muted">Nothing is waiting for you.</p>
        )}
        {[...groups].map(([memberId, items]) => (
          <section
            key={memberId}
            className="approvals-group"
            aria-label={`Asked by ${items[0]?.memberName ?? ''}`}
          >
            {groups.size > 1 && (
              <h3 className="approvals-asker">
                <span>{items[0]?.memberName}</span>
                <span className="mono muted">{items.length}</span>
              </h3>
            )}
            <ul className="approvals-list">
              {items.map((item) => (
                <ApprovalRow
                  key={item.approvalId}
                  item={item}
                  approve={!declined.has(item.approvalId)}
                  locked={locked}
                  outcome={outcomes.get(item.approvalId)}
                  always={always.has(item.commandId)}
                  onCost={onCost}
                  onToggle={() => {
                    const next = new Set(declined);
                    if (next.has(item.approvalId)) next.delete(item.approvalId);
                    else next.add(item.approvalId);
                    setDeclined(next);
                  }}
                  onAlways={(on) => {
                    const next = new Set(always);
                    if (on) next.add(item.commandId);
                    else next.delete(item.commandId);
                    setAlways(next);
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
        {problem !== null && <p className="error">{problem}</p>}
      </div>

      {shown.length > 0 && (
        <footer className="approvals-foot">
          <div className="approvals-total" aria-live="polite">
            {phase === 'review' ? (
              <>
                <span className="eyebrow">If approved</span>
                <span className="approvals-sum">
                  {approvedCount === 0 ? '$0.00' : `≈ ${formatUsd(total)}`}
                  {unknown && approvedCount > 0 && <span className="muted"> + unpriced</span>}
                </span>
              </>
            ) : phase === 'working' ? (
              <span className="row">
                <ImpSpinner /> Working through your decisions
              </span>
            ) : (
              <span>
                {[...outcomes.values()].some((outcome) => outcome.state === 'failed')
                  ? 'Done, with problems shown above.'
                  : 'Done. The crew goes on.'}
              </span>
            )}
          </div>
          {phase === 'review' ? (
            <div className="row approvals-actions">
              {shown.length > 1 && approvedCount > 0 && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    void decide('none');
                  }}
                >
                  <XIcon aria-hidden="true" /> Decline all
                </button>
              )}
              <button
                type="button"
                className={approvedCount === 0 ? 'button danger' : 'button primary'}
                onClick={() => {
                  void decide(declinedCount === 0 ? 'all' : 'picked');
                }}
              >
                {approvedCount === 0 ? (
                  <XIcon aria-hidden="true" />
                ) : (
                  <CheckIcon aria-hidden="true" />
                )}{' '}
                {primaryLabel}
              </button>
            </div>
          ) : (
            <button type="button" className="button" disabled={phase === 'working'} onClick={close}>
              Close
            </button>
          )}
        </footer>
      )}
    </dialog>
  );
}

/** The actions agents may take without asking, with a way to make them ask again. */
export function AlwaysAllowed(): ReactElement {
  const imp = useImp();
  const [problem, setProblem] = useState<string | null>(null);
  const list = useLive(['approvals/'], async (current) =>
    AlwaysList.parse(await runCommand(current, 'crew.approvals.always.list', {})),
  );
  const commands = list.data?.commands ?? [];
  return (
    <div className="stack">
      <p className="muted">
        Agents ask before they spend money or delete anything. What you always allow, they do
        without asking. Only you can change this list; agents cannot.
      </p>
      {commands.length === 0 ? (
        <p className="muted small">Nothing is always allowed. Agents ask every time.</p>
      ) : (
        <ul className="always-list">
          {commands.map((command) => (
            <li key={command.commandId}>
              <span className="stack">
                <strong>{command.title}</strong>
                <span className="mono muted small">{command.commandId}</span>
              </span>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  setProblem(null);
                  runCommand(imp, 'crew.approvals.always.set', {
                    commandId: command.commandId,
                    allow: false,
                  }).catch((reason: unknown) => {
                    setProblem(messageOf(reason));
                  });
                }}
              >
                Ask again
              </button>
            </li>
          ))}
        </ul>
      )}
      {(problem ?? list.error) !== null && <p className="error">{problem ?? list.error}</p>}
    </div>
  );
}
