import { CrewMember, WorkBoardSchema, type WorkBoard, type WorkEntry } from '@imp/agents';
import { openApprovals } from './Approvals.js';
import {
  BrainIcon,
  CheckCircleIcon,
  ChatCircleDotsIcon,
  CrownSimpleIcon,
  CubeIcon,
  EyeIcon,
  FilmSlateIcon,
  HandPalmIcon,
  HourglassMediumIcon,
  LifebuoyIcon,
  MaskHappyIcon,
  PenNibIcon,
  ScissorsIcon,
  SlidersHorizontalIcon,
  StopCircleIcon,
  UserIcon,
  WarningCircleIcon,
  WaveformIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import { runCommand, useImp, useLive } from './context.js';
import { ImpSpinner } from './ImpMark.js';
import { formatUsd as formatCents } from './spend.js';

/** Agent runs cost fractions of a cent, so small amounts keep four places. */
function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.1 ? `$${usd.toFixed(4)}` : formatCents(usd);
}
import { STAGE_ICONS } from './stage-icons.js';

/**
 * The crew at work: who is working on what right now, live. One reading of
 * the board (crew.work.list, the same command agents use) is shared by the
 * top-bar indicator, the board itself, the stage navigation and the badges on
 * the scenes, shots and characters being worked on.
 */

/** Asks the shell to open the crew panel on one member's conversation. */
export const TALK_TO = 'imp:talk-to';

export function talkTo(memberId: string): void {
  window.dispatchEvent(new CustomEvent(TALK_TO, { detail: memberId }));
}

const CrewList = z.object({ crew: z.array(CrewMember) });

interface WorkState {
  readonly board: WorkBoard | undefined;
  readonly crew: readonly CrewMember[];
}

const WorkContext = createContext<WorkState>({ board: undefined, crew: [] });

export function WorkProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const live = useLive(
    ['work/', 'conversations/', 'crew/', 'settings/project.current'],
    async (imp) => {
      const [board, crew] = await Promise.all([
        runCommand(imp, 'crew.work.list', { scope: 'project', limit: 20 }),
        runCommand(imp, 'crew.list', {}),
      ]);
      return { board: WorkBoardSchema.parse(board), crew: CrewList.parse(crew).crew };
    },
  );
  return (
    <WorkContext.Provider
      value={{ board: live.data?.board, crew: live.data?.crew ?? ([] as CrewMember[]) }}
    >
      {children}
    </WorkContext.Provider>
  );
}

export function useWork(): WorkState {
  return useContext(WorkContext);
}

/* ------------------------------------------------------------------ avatars */

const ROLE_ICONS: Readonly<Record<string, Icon>> = {
  coordinator: CrownSimpleIcon,
  guide: LifebuoyIcon,
  screenwriter: PenNibIcon,
  'casting-director': MaskHappyIcon,
  'production-designer': CubeIcon,
  'clip-designer': FilmSlateIcon,
  'sound-designer': WaveformIcon,
  'film-editor': ScissorsIcon,
  'sound-editor': SlidersHorizontalIcon,
  critic: EyeIcon,
};

/** Each role keeps its own colour, picked from the role id so it never changes. */
export function roleHue(roleId: string): number {
  const fixed: Record<string, number> = {
    coordinator: 38,
    screenwriter: 18,
    'casting-director': 340,
    'production-designer': 160,
    'clip-designer': 205,
    'sound-designer': 265,
    'film-editor': 0,
    'sound-editor': 290,
    critic: 95,
    guide: 185,
  };
  if (fixed[roleId] !== undefined) return fixed[roleId];
  let hash = 0;
  for (const char of roleId) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/**
 * A crew member's face: its role's sign on its role's colour. While it works
 * it grows the imp's horns and a gold ring runs round it.
 */
export function CrewAvatar({
  name,
  roleId,
  working = false,
  size = 36,
  title,
}: {
  readonly name: string;
  readonly roleId: string;
  readonly working?: boolean;
  readonly size?: number;
  readonly title?: string;
}): ReactElement {
  const RoleIcon = ROLE_ICONS[roleId] ?? UserIcon;
  return (
    <span
      className="crew-avatar"
      data-working={working ? 'true' : undefined}
      style={{ '--avatar-size': `${String(size)}px`, '--hue': roleHue(roleId) } as CSSProperties}
      title={title ?? name}
      role="img"
      aria-label={title ?? name}
    >
      {working && (
        <svg className="crew-avatar-horns" viewBox="0 0 40 16" aria-hidden="true">
          <path d="M11 15 C7 11 6 6 8 1 C10 6 13 10 16 12 Z" />
          <path d="M29 15 C33 11 34 6 32 1 C30 6 27 10 24 12 Z" />
        </svg>
      )}
      <span className="crew-avatar-face">
        <RoleIcon aria-hidden="true" weight="duotone" size={Math.round(size * 0.52)} />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------- times */

/** The time now, ticking once a second while `ticking` is true. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [ticking]);
  return now;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')} min`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

function ago(at: string, now: number): string {
  const minutes = Math.round((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return new Date(at).toLocaleDateString();
}

/* -------------------------------------------------------------- what's what */

/** Whether a run is on a scene, shot, character or place right now, or changed it. */
export function worksOn(entry: WorkEntry, kind: string, id: string): boolean {
  const now =
    entry.now?.kind === 'command'
      ? entry.now.subjects
      : entry.now?.kind === 'thinking'
        ? (entry.now.after?.subjects ?? [])
        : [];
  return [...now, ...entry.subjects].some((subject) => subject.kind === kind && subject.id === id);
}

/** The stage a working run is in now, or the last one it was in. */
export function stageOfRun(entry: WorkEntry): string | null {
  return (entry.now?.kind === 'command' ? entry.now.stage : null) ?? entry.stages.at(-1) ?? null;
}

/** The runs going on, each followed by the runs it handed out, so delegation reads as a tree. */
function asTree(working: readonly WorkEntry[]): { entry: WorkEntry; depth: number }[] {
  const ids = new Set(working.map((entry) => entry.id));
  const out: { entry: WorkEntry; depth: number }[] = [];
  const visit = (entry: WorkEntry, depth: number): void => {
    out.push({ entry, depth });
    for (const child of working.filter((candidate) => candidate.parentId === entry.id)) {
      visit(child, depth + 1);
    }
  };
  for (const root of working.filter(
    (entry) => entry.parentId === null || !ids.has(entry.parentId),
  )) {
    visit(root, 0);
  }
  return out;
}

const STATUS: Record<
  Exclude<WorkEntry['status'], 'working'>,
  { label: string; icon: Icon; tone: string }
> = {
  completed: { label: 'Done', icon: CheckCircleIcon, tone: 'ok' },
  'awaiting-approval': { label: 'Asked you', icon: HandPalmIcon, tone: 'wait' },
  'step-limit': { label: 'Step limit', icon: HourglassMediumIcon, tone: 'wait' },
  'budget-exhausted': { label: 'Budget used up', icon: HourglassMediumIcon, tone: 'wait' },
  cancelled: { label: 'Interrupted', icon: StopCircleIcon, tone: 'muted' },
  failed: { label: 'Failed', icon: WarningCircleIcon, tone: 'danger' },
};

function useStageNames(): (stage: string) => string {
  const imp = useImp();
  const names = new Map(imp.modes.flatMap((mode) => mode.stages.map((s) => [s.id, s.name])));
  return (stage) => names.get(stage) ?? stage;
}

function StageChip({ stage }: { readonly stage: string }): ReactElement {
  const name = useStageNames()(stage);
  const StageIcon = STAGE_ICONS[stage] ?? FilmSlateIcon;
  return (
    <span className="work-chip stage">
      <StageIcon aria-hidden="true" size={13} />
      {name}
    </span>
  );
}

function SubjectChips({
  subjects,
  max = 4,
}: {
  readonly subjects: WorkEntry['subjects'];
  readonly max?: number;
}): ReactElement | null {
  const named = subjects.filter((subject) => subject.label !== null);
  if (named.length === 0) return null;
  const shown = named.slice(-max);
  return (
    <>
      {shown.map((subject) => (
        <span key={`${subject.kind}:${subject.id}`} className="work-chip subject">
          {subject.label}
        </span>
      ))}
      {named.length > shown.length && (
        <span className="work-chip more">+{named.length - shown.length}</span>
      )}
    </>
  );
}

/* ------------------------------------------------------------ the top bar */

/** The crew at work, in the top bar: faces of whoever is working, and who waits for you. */
export function WorkIndicator(): ReactElement | null {
  const { board, crew } = useWork();
  const dialog = useRef<HTMLDialogElement>(null);
  // The board is only drawn while it is open, so its texts are not on the page twice.
  const [open, setOpen] = useState(false);
  if (board === undefined || crew.length === 0) return null;
  const working = board.working;
  const waiting = board.waiting.length;
  const faces = working.slice(0, 3);
  const label =
    working.length === 0
      ? 'The crew is free'
      : working.length === 1
        ? `${working[0]?.memberName ?? ''} is working`
        : `${String(working.length)} at work`;
  return (
    <>
      <button
        className="button quiet work-indicator"
        data-busy={working.length > 0 ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-label={`${label}${waiting > 0 ? `, ${String(waiting)} waiting for you` : ''}. Show who is working on what`}
        title="Who is working on what"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        {faces.length === 0 ? (
          <ChatCircleDotsIcon aria-hidden="true" size={18} />
        ) : (
          <span className="work-faces" aria-hidden="true">
            {faces.map((entry) => (
              <CrewAvatar
                key={entry.id}
                name={entry.memberName}
                roleId={entry.roleId}
                working
                size={24}
              />
            ))}
          </span>
        )}
        <span className="label">{label}</span>
        {waiting > 0 && (
          <span className="work-waiting-dot" aria-hidden="true">
            {waiting}
          </span>
        )}
      </button>
      {/* A tap on the dimmed backdrop closes the board, as Escape does; a tablet has no Escape key. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
      <dialog
        ref={dialog}
        className="modal work-dialog"
        aria-labelledby="work-title"
        onClose={() => {
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {open && (
          <WorkBoardView
            onClose={() => dialog.current?.close()}
            onTalk={(memberId) => {
              dialog.current?.close();
              talkTo(memberId);
            }}
          />
        )}
      </dialog>
    </>
  );
}

/* --------------------------------------------------------------- the board */

function WorkingCard({
  entry,
  depth,
  now,
  onTalk,
}: {
  readonly entry: WorkEntry;
  readonly depth: number;
  readonly now: number;
  readonly onTalk: (memberId: string) => void;
}): ReactElement {
  const stage = stageOfRun(entry);
  const doing =
    entry.now === null
      ? 'Getting started'
      : entry.now.kind === 'thinking'
        ? 'Thinking'
        : entry.now.title;
  const budget = entry.budgetUsd > 0 ? Math.min(1, entry.costUsd / entry.budgetUsd) : 0;
  return (
    <li
      className="work-card"
      data-depth={depth > 0 ? 'child' : undefined}
      style={{ '--depth': depth, '--hue': roleHue(entry.roleId) } as CSSProperties}
    >
      <CrewAvatar name={entry.memberName} roleId={entry.roleId} working size={44} />
      <div className="work-card-body">
        <div className="work-card-head">
          <span className="work-name">{entry.memberName}</span>
          {entry.roleName !== entry.memberName && (
            <span className="work-role">{entry.roleName}</span>
          )}
          {entry.askedBy.kind === 'agent' && (
            <span className="work-asked">asked by {entry.askedBy.name ?? 'an agent'}</span>
          )}
          <span className="work-elapsed mono">
            {formatDuration(now - Date.parse(entry.startedAt))}
          </span>
        </div>
        {entry.task !== null ? (
          <p className="work-task">{entry.task}</p>
        ) : (
          <p className="work-task muted">Going on where it stopped</p>
        )}
        <div className="work-now" aria-live="polite">
          {entry.now?.kind === 'thinking' ? (
            <BrainIcon className="work-now-icon" aria-hidden="true" size={16} />
          ) : (
            <ImpSpinner size={16} />
          )}
          <span className="work-now-text">{doing}</span>
          {entry.now?.kind === 'thinking' && entry.now.after !== null && (
            <span className="work-now-after">after {entry.now.after.title.toLowerCase()}</span>
          )}
          {stage !== null && <StageChip stage={stage} />}
          {entry.now?.kind === 'command' && <SubjectChips subjects={entry.now.subjects} max={3} />}
          {entry.now?.kind === 'thinking' && entry.now.after !== null && (
            <SubjectChips subjects={entry.now.after.subjects} max={3} />
          )}
        </div>
        <div className="work-meters">
          <span
            className="work-meter"
            title={`Step ${String(entry.steps)} of at most ${String(entry.maxSteps)}`}
          >
            <span className="work-meter-label">
              Step {entry.steps}/{entry.maxSteps}
            </span>
            <span className="work-meter-track" aria-hidden="true">
              <span
                className="work-meter-fill"
                style={{ width: `${String(Math.min(100, (entry.steps / entry.maxSteps) * 100))}%` }}
              />
            </span>
          </span>
          <span
            className="work-meter cost"
            title={`${formatUsd(entry.costUsd)} of the ${formatUsd(entry.budgetUsd)} this agent may spend on one run`}
          >
            <span className="work-meter-label mono">{formatUsd(entry.costUsd)}</span>
            <span className="work-meter-track" aria-hidden="true">
              <span className="work-meter-fill" style={{ width: `${String(budget * 100)}%` }} />
            </span>
          </span>
          <button
            type="button"
            className="button quiet small"
            onClick={() => {
              onTalk(entry.memberId);
            }}
          >
            Watch
          </button>
        </div>
        {entry.subjects.length > 0 && (
          <div className="work-touched">
            <span className="muted small">Changed</span>
            <SubjectChips subjects={entry.subjects} max={5} />
          </div>
        )}
      </div>
    </li>
  );
}

function DoneRow({
  entry,
  now,
}: {
  readonly entry: WorkEntry;
  readonly now: number;
}): ReactElement {
  const status = STATUS[entry.status as Exclude<WorkEntry['status'], 'working'>];
  const StatusIcon = status.icon;
  const took = entry.endedAt === null ? 0 : Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
  return (
    <li className="work-done">
      <details>
        <summary>
          <CrewAvatar name={entry.memberName} roleId={entry.roleId} size={28} />
          <span className="work-done-main">
            <span className="work-done-line">
              <span className="work-name">{entry.memberName}</span>
              <span className={`work-status ${status.tone}`}>
                <StatusIcon aria-hidden="true" size={14} weight="fill" /> {status.label}
              </span>
            </span>
            <span className="work-done-task">{entry.task ?? 'Went on where it stopped'}</span>
          </span>
          <span className="work-done-meta mono">
            <span>{formatUsd(entry.costUsd)}</span>
            <span className="muted">{ago(entry.endedAt ?? entry.updatedAt, now)}</span>
          </span>
        </summary>
        <div className="work-done-more">
          <div className="work-done-chips">
            {entry.stages.map((stage) => (
              <StageChip key={stage} stage={stage} />
            ))}
            <SubjectChips subjects={entry.subjects} max={8} />
          </div>
          {entry.summary !== null && entry.summary !== '' && (
            <p className="work-summary">{entry.summary}</p>
          )}
          {entry.error !== null && <p className="error small">{entry.error}</p>}
          <p className="muted small">
            {entry.askedBy.kind === 'agent'
              ? `Asked by ${entry.askedBy.name ?? 'an agent'}`
              : 'Asked by you'}{' '}
            · {entry.commands} commands in {entry.steps} steps · took {formatDuration(took)}
          </p>
        </div>
      </details>
    </li>
  );
}

export function WorkBoardView({
  onClose,
  onTalk,
}: {
  readonly onClose?: () => void;
  readonly onTalk: (memberId: string) => void;
}): ReactElement {
  const { board, crew } = useWork();
  const now = useNow((board?.working.length ?? 0) > 0);
  const working = board?.working ?? [];
  const busy = new Set(working.map((entry) => entry.memberId));
  const free = crew.filter((member) => !busy.has(member.id));
  const imp = useImp();
  const titleOf = (commandId: string): string =>
    imp.commands.find((command) => command.id === commandId)?.title ?? commandId;
  return (
    <>
      <header className="spend-head work-head">
        <div className="stack">
          <span className="eyebrow">Crew at work</span>
          <h2 id="work-title">Who is working on what</h2>
        </div>
        <div className="work-head-totals">
          <span className="work-total" title="What the runs going on have cost so far">
            <span className="muted small">Running now</span>
            <span className="mono">{formatUsd(board?.workingUsd ?? 0)}</span>
          </span>
          {onClose !== undefined && (
            <button className="button quiet icon" aria-label="Close" onClick={onClose}>
              <XIcon aria-hidden="true" size={18} />
            </button>
          )}
        </div>
      </header>
      <div className="work-body stack">
        {(board?.waiting.length ?? 0) > 0 && (
          <section className="stack" aria-labelledby="work-waiting">
            <h3 id="work-waiting" className="eyebrow">
              Waiting for you
            </h3>
            <ul className="work-list">
              {board?.waiting.map((waiting) => {
                const member = crew.find((candidate) => candidate.id === waiting.memberId);
                return (
                  <li key={waiting.memberId} className="work-waiting">
                    <CrewAvatar name={waiting.memberName} roleId={member?.roleId ?? ''} size={36} />
                    <span className="work-waiting-text">
                      <strong>{waiting.memberName}</strong> asks to{' '}
                      {waiting.commandIds.map((id) => titleOf(id).toLowerCase()).join(', ')}
                    </span>
                    <button
                      type="button"
                      className="button primary small"
                      onClick={() => {
                        // The chat shows the agent's reasons; the dialog decides everything at once.
                        onTalk(waiting.memberId);
                        openApprovals();
                      }}
                    >
                      Decide
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section className="stack" aria-labelledby="work-now-heading">
          <h3 id="work-now-heading" className="eyebrow">
            Working now
          </h3>
          {working.length === 0 ? (
            <p className="work-empty muted">
              Nobody is working right now. Give an agent a task in the crew panel, and you will see
              here what it does, step by step.
            </p>
          ) : (
            <ul className="work-list">
              {asTree(working).map(({ entry, depth }) => (
                <WorkingCard key={entry.id} entry={entry} depth={depth} now={now} onTalk={onTalk} />
              ))}
            </ul>
          )}
          {free.length > 0 && (
            <div className="work-free">
              <span className="muted small">Free</span>
              <span className="work-free-faces">
                {free.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    className="work-free-member"
                    title={`Talk to ${member.name}`}
                    onClick={() => {
                      onTalk(member.id);
                    }}
                  >
                    <CrewAvatar name={member.name} roleId={member.roleId} size={28} />
                    <span>{member.name}</span>
                  </button>
                ))}
              </span>
            </div>
          )}
        </section>
        <section className="stack" aria-labelledby="work-done-heading">
          <h3 id="work-done-heading" className="eyebrow">
            Done lately
            {(board?.recent.length ?? 0) > 0 && (
              <span className="mono muted"> · {formatUsd(board?.recentUsd ?? 0)}</span>
            )}
          </h3>
          {(board?.recent.length ?? 0) === 0 ? (
            <p className="muted small">No finished work in this project yet.</p>
          ) : (
            <ol className="work-list">
              {board?.recent.map((entry) => (
                <DoneRow key={entry.id} entry={entry} now={now} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ badges */

/** The faces of whoever works in a stage right now, for its entry in the navigation. */
export function StageWorkers({ stage }: { readonly stage: string }): ReactElement | null {
  const { board } = useWork();
  const here = (board?.working ?? []).filter((entry) => stageOfRun(entry) === stage);
  if (here.length === 0) return null;
  return (
    <span
      className="stage-workers"
      title={`${here.map((entry) => entry.memberName).join(', ')} working here`}
    >
      {here.slice(0, 2).map((entry) => (
        <CrewAvatar
          key={entry.id}
          name={entry.memberName}
          roleId={entry.roleId}
          working
          size={18}
        />
      ))}
    </span>
  );
}

/**
 * A small sign on a scene, shot, character or place that an agent is working
 * on: its face and what it is doing, so nobody edits the same thing at once
 * without knowing.
 */
export function WorkingOn({
  kind,
  id,
  compact = false,
}: {
  readonly kind: string;
  readonly id: string;
  /** Faces only, for a chip or a tab. */
  readonly compact?: boolean;
}): ReactElement | null {
  const { board } = useWork();
  const on = (board?.working ?? []).filter((entry) => worksOn(entry, kind, id));
  const [first] = on;
  if (first === undefined) return null;
  const names = on.map((entry) => entry.memberName).join(' and ');
  const doing = first.now?.kind === 'command' ? first.now.title.toLowerCase() : 'working';
  if (compact) {
    return (
      <span className="working-on compact" title={`${names}: ${doing}`}>
        {on.slice(0, 2).map((entry) => (
          <CrewAvatar
            key={entry.id}
            name={entry.memberName}
            roleId={entry.roleId}
            working
            size={16}
          />
        ))}
      </span>
    );
  }
  return (
    <span className="working-on" title={`${names}: ${doing}`} role="status">
      {on.slice(0, 2).map((entry) => (
        <CrewAvatar
          key={entry.id}
          name={entry.memberName}
          roleId={entry.roleId}
          working
          size={20}
        />
      ))}
      <span className="working-on-text">
        {on.length > 1 ? names : `${first.memberName} at work`}
      </span>
    </span>
  );
}
