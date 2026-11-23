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
import { currentLanguage, t, tn, tx } from '../i18n/i18n.js';

/** A command's title inside a sentence: lower-case in English, as the language writes it otherwise. */
function commandWords(title: string): string {
  const words = tx(title);
  return currentLanguage() === 'en' ? words.toLowerCase() : words;
}

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
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{minutes} min ago', { minutes: String(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('{hours} h ago', { hours: String(hours) });
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
  completed: {
    get label(): string {
      return t('Done');
    },
    icon: CheckCircleIcon,
    tone: 'ok',
  },
  'awaiting-approval': {
    get label(): string {
      return t('Asked you');
    },
    icon: HandPalmIcon,
    tone: 'wait',
  },
  'step-limit': {
    get label(): string {
      return t('Step limit');
    },
    icon: HourglassMediumIcon,
    tone: 'wait',
  },
  'budget-exhausted': {
    get label(): string {
      return t('Budget used up');
    },
    icon: HourglassMediumIcon,
    tone: 'wait',
  },
  cancelled: {
    get label(): string {
      return t('Interrupted');
    },
    icon: StopCircleIcon,
    tone: 'muted',
  },
  failed: {
    get label(): string {
      return t('Failed');
    },
    icon: WarningCircleIcon,
    tone: 'danger',
  },
  blocked: {
    get label(): string {
      return t('Something is missing');
    },
    icon: HandPalmIcon,
    tone: 'wait',
  },
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
      ? t('The crew is free')
      : working.length === 1
        ? t('{name} is working', { name: working[0]?.memberName ?? '' })
        : t('{count} at work', { count: String(working.length) });
  return (
    <>
      <button
        className="button quiet work-indicator"
        data-busy={working.length > 0 ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-label={
          waiting > 0
            ? t('{label}, {waiting} waiting for you. Show who is working on what', {
                label,
                waiting,
              })
            : t('{label}. Show who is working on what', { label })
        }
        title={t('Who is working on what')}
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
      ? t('Getting started')
      : entry.now.kind === 'thinking'
        ? t('Thinking')
        : tx(entry.now.title);
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
            <span className="work-asked">
              {t('asked by {name}', { name: entry.askedBy.name ?? t('an agent') })}
            </span>
          )}
          <span className="work-elapsed mono">
            {formatDuration(now - Date.parse(entry.startedAt))}
          </span>
        </div>
        {entry.task !== null ? (
          <p className="work-task">{entry.task}</p>
        ) : (
          <p className="work-task muted">{t('Going on where it stopped')}</p>
        )}
        <div className="work-now" aria-live="polite">
          {entry.now?.kind === 'thinking' ? (
            <BrainIcon className="work-now-icon" aria-hidden="true" size={16} />
          ) : (
            <ImpSpinner size={16} />
          )}
          <span className="work-now-text">{doing}</span>
          {entry.now?.kind === 'thinking' && entry.now.after !== null && (
            <span className="work-now-after">
              {t('after {command}', { command: commandWords(entry.now.after.title) })}
            </span>
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
            title={t('Step {steps} of at most {maxSteps}', {
              steps: String(entry.steps),
              maxSteps: String(entry.maxSteps),
            })}
          >
            <span className="work-meter-label">{`${t('Step')} ${String(entry.steps)}/${String(entry.maxSteps)}`}</span>
            <span className="work-meter-track" aria-hidden="true">
              <span
                className="work-meter-fill"
                style={{ width: `${String(Math.min(100, (entry.steps / entry.maxSteps) * 100))}%` }}
              />
            </span>
          </span>
          <span
            className="work-meter cost"
            title={t('{costUsd} of the {budgetUsd} this agent may spend on one run', {
              costUsd: formatUsd(entry.costUsd),
              budgetUsd: formatUsd(entry.budgetUsd),
            })}
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
            {t('Watch')}
          </button>
        </div>
        {entry.subjects.length > 0 && (
          <div className="work-touched">
            <span className="muted small">{t('Changed')}</span>
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
            <span className="work-done-task">{entry.task ?? t('Went on where it stopped')}</span>
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
              ? t('Asked by {name}', { name: entry.askedBy.name ?? t('an agent') })
              : t('Asked by you')}{' '}
            · {tn(entry.commands, '{count} command', '{count} commands')} ·{' '}
            {tn(entry.steps, '{count} step', '{count} steps')} ·{' '}
            {t('took {duration}', { duration: formatDuration(took) })}
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
          <span className="eyebrow">{t('Crew at work')}</span>
          <h2 id="work-title">{t('Who is working on what')}</h2>
        </div>
        <div className="work-head-totals">
          <span className="work-total" title={t('What the runs going on have cost so far')}>
            <span className="muted small">{t('Running now')}</span>
            <span className="mono">{formatUsd(board?.workingUsd ?? 0)}</span>
          </span>
          {onClose !== undefined && (
            <button className="button quiet icon" aria-label={t('Close')} onClick={onClose}>
              <XIcon aria-hidden="true" size={18} />
            </button>
          )}
        </div>
      </header>
      <div className="work-body stack">
        {(board?.waiting.length ?? 0) > 0 && (
          <section className="stack" aria-labelledby="work-waiting">
            <h3 id="work-waiting" className="eyebrow">
              {t('Waiting for you')}
            </h3>
            <ul className="work-list">
              {board?.waiting.map((waiting) => {
                const member = crew.find((candidate) => candidate.id === waiting.memberId);
                return (
                  <li key={waiting.memberId} className="work-waiting">
                    <CrewAvatar name={waiting.memberName} roleId={member?.roleId ?? ''} size={36} />
                    <span className="work-waiting-text">
                      <strong>{waiting.memberName}</strong>{' '}
                      {t('asks to {commands}', {
                        commands: waiting.commandIds
                          .map((id) => commandWords(titleOf(id)))
                          .join(', '),
                      })}
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
                      {t('Decide')}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section className="stack" aria-labelledby="work-now-heading">
          <h3 id="work-now-heading" className="eyebrow">
            {t('Working now')}
          </h3>
          {working.length === 0 ? (
            <p className="work-empty muted">
              {t(
                'Nobody is working right now. Give an agent a task in the crew panel, and you will see here what it does, step by step.',
              )}
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
              <span className="muted small">{t('Free')}</span>
              <span className="work-free-faces">
                {free.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    className="work-free-member"
                    title={t('Talk to {name}', { name: member.name })}
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
            {t('Done lately')}
            {(board?.recent.length ?? 0) > 0 && (
              <span className="mono muted"> · {formatUsd(board?.recentUsd ?? 0)}</span>
            )}
          </h3>
          {(board?.recent.length ?? 0) === 0 ? (
            <p className="muted small">{t('No finished work in this project yet.')}</p>
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
      title={t('{names} working here', { names: here.map((entry) => entry.memberName).join(', ') })}
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
  const names = on.map((entry) => entry.memberName).join(t(' and '));
  const doing = first.now?.kind === 'command' ? commandWords(first.now.title) : t('working');
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
        {on.length > 1 ? names : t('{memberName} at work', { memberName: first.memberName })}
      </span>
    </span>
  );
}
