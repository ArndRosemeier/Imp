import {
  CopyRequest,
  fileNameFor,
  itemKey,
  Project,
  ProjectSummary,
  ResourceItem,
  ResourceKindInfo,
  Template,
  type CollisionChoice,
  type PlannedItem,
  type PhrasePart,
} from '@imp/core';
import {
  ArrowsLeftRightIcon,
  BookmarkSimpleIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  LighthouseIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react';
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { useHelpState } from './help/help.js';
import { Problem, useBlobUrl } from './movie.js';
import { saveFileAs } from './save-file.js';
import { BackupButton } from './backup.js';
import { ImpAlias } from './imp-names.js';
import { currentLanguage, fixed, t, tn, tx } from '../i18n/i18n.js';

const OverviewEntry = Project.extend({
  summary: ProjectSummary.nullable(),
  progress: z.number(),
});
type OverviewEntry = z.infer<typeof OverviewEntry>;
const Overview = z.object({
  projects: z.array(OverviewEntry),
  currentProjectId: z.string().nullable(),
});
const Templates = z.object({ templates: z.array(Template) });
const Resources = z.object({ kinds: z.array(ResourceKindInfo), items: z.array(ResourceItem) });
const Requests = z.object({ requests: z.array(CopyRequest) });
const Exported = z.object({ fileKey: z.string(), fileName: z.string(), sizeBytes: z.number() });
interface Listed {
  readonly projectId: string;
  readonly data: z.infer<typeof Resources>;
}
const CopyResult = z.object({ status: z.string(), outcomes: z.array(z.unknown()).optional() });

const CHOICE_LABELS: Record<CollisionChoice, string> = {
  get overwrite(): string {
    return t('Overwrite');
  },
  get keepBoth(): string {
    return t('Keep both');
  },
  get skip(): string {
    return t('Skip');
  },
};

/** A dialog that opens and closes with `open`. Escape and the backdrop close it through `onClose`. */
export function Modal({
  open,
  onClose,
  label,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  wide?: boolean;
  children: ReactNode;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={wide ? 'modal wide' : 'modal'}
      aria-label={label}
      onClose={onClose}
    >
      {open && children}
    </dialog>
  );
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return t('just now');
}

function sizeOf(bytes: number): string {
  if (bytes < 1024 * 1024)
    return t('{value} KB', { value: String(Math.max(1, Math.round(bytes / 1024))) });
  return t('{value} MB', { value: fixed(bytes / 1024 / 1024, 1) });
}

function Poster({ entry }: { entry: OverviewEntry }): ReactElement {
  const keys = entry.summary?.posterKeys ?? [];
  return (
    <div className="poster" data-count={keys.length}>
      {keys.length === 0 ? (
        <span className="poster-mark" aria-hidden="true">
          {entry.name.trim().charAt(0).toUpperCase()}
        </span>
      ) : (
        keys.map((key) => <PosterImage key={key} blobKey={key} />)
      )}
      <span className="poster-progress" title={t('Overall progress')}>
        {Math.round(entry.progress * 100)}%
      </span>
    </div>
  );
}

function PosterImage({ blobKey }: { blobKey: string }): ReactElement {
  const url = useBlobUrl(blobKey);
  return url === null ? <span className="poster-cell" /> : <img src={url} alt="" />;
}

/** A stage's progress line, in the interface's language when the core gave it in parts. */
function stageNote(stage: { note: string; phrase?: readonly PhrasePart[] | undefined }): string {
  return stage.phrase === undefined
    ? stage.note
    : stage.phrase.map((part) => tx(part.text, part.values)).join(', ');
}

function StageMeter({ entry }: { entry: OverviewEntry }): ReactElement | null {
  const stages = entry.summary?.stages ?? [];
  if (stages.length === 0) return null;
  return (
    <ul className="stages" aria-label={t('Progress by stage')}>
      {stages.map((stage) => {
        const share = stage.total === 0 ? 0 : stage.done / stage.total;
        return (
          <li key={stage.id} title={stageNote(stage)}>
            <span className="stage-name">{tx(stage.name)}</span>
            <span className="stage-bar" aria-hidden="true">
              <span style={{ width: `${String(Math.round(share * 100))}%` }} />
            </span>
            <span className="stage-count">
              {stage.total === 0 ? '–' : `${String(stage.done)}/${String(stage.total)}`}
            </span>
            <span className="sr-only">{stageNote(stage)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectCard({
  entry,
  current,
  onOpen,
  onAct,
}: {
  entry: OverviewEntry;
  current: boolean;
  onOpen: () => void;
  onAct: (action: 'duplicate' | 'template' | 'export' | 'copy' | 'delete') => void;
}): ReactElement {
  const imp = useImp();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const rename = (event: SyntheticEvent): void => {
    event.preventDefault();
    const next = name.trim();
    setRenaming(false);
    if (next === '' || next === entry.name) {
      setName(entry.name);
      return;
    }
    runCommand(imp, 'project.rename', { projectId: entry.id, name: next }).catch(
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  const tool = (
    label: string,
    icon: ReactElement,
    action: () => void,
    danger = false,
  ): ReactElement => (
    <li>
      <button
        type="button"
        className={danger ? 'project-action danger-quiet' : 'project-action'}
        aria-label={`${label}: ${entry.name}`}
        onClick={() => {
          setMenu(false);
          action();
        }}
      >
        {icon}
        <span>{label}</span>
      </button>
    </li>
  );
  return (
    <article className="project-card" aria-current={current ? 'true' : undefined}>
      <button
        className="project-open"
        onClick={onOpen}
        aria-label={t('Open {name}', { name: entry.name })}
      >
        <Poster entry={entry} />
      </button>
      <div className="project-body">
        <div className="row spread project-title-row">
          {renaming ? (
            <form onSubmit={rename} className="project-rename">
              <input
                className="input"
                aria-label={t('Project name')}
                value={name}
                // Focus follows the person's own click on Rename.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(event) => {
                  setName(event.target.value);
                }}
                onBlur={rename}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setName(entry.name);
                    setRenaming(false);
                  }
                }}
              />
            </form>
          ) : (
            <h2 className="project-title">
              <button className="link-button" onClick={onOpen}>
                {entry.name}
              </button>
            </h2>
          )}
          {current && <span className="tag accent">{t('Open')}</span>}
        </div>
        <p className="project-headline muted">
          {entry.summary?.headline !== undefined && entry.summary.headline !== ''
            ? entry.summary.headline
            : t('No logline yet.')}
        </p>
        <StageMeter entry={entry} />
        <Problem text={error} />
      </div>
      <footer className="project-foot row spread">
        <span className="muted small">
          {entry.mode.charAt(0).toUpperCase() + entry.mode.slice(1)} ·{' '}
          {entry.openedAt === null
            ? `made ${ago(entry.createdAt)}`
            : `opened ${ago(entry.openedAt)}`}
        </span>
        <div className="project-actions" ref={menuRef}>
          <button
            type="button"
            className="button quiet small"
            aria-expanded={menu}
            aria-controls={`project-actions-${entry.id}`}
            aria-label={t('Actions for {name}', { name: entry.name })}
            onClick={() => {
              setMenu(!menu);
            }}
          >
            <DotsThreeIcon aria-hidden="true" weight="bold" /> {t('Actions')}
          </button>
          {menu && (
            <ul id={`project-actions-${entry.id}`} className="project-action-list">
              {tool(t('Rename'), <PencilSimpleIcon aria-hidden="true" />, () => {
                setName(entry.name);
                setRenaming(true);
              })}
              {tool(t('Duplicate'), <CopyIcon aria-hidden="true" />, () => {
                onAct('duplicate');
              })}
              {tool(t('Save as template'), <BookmarkSimpleIcon aria-hidden="true" />, () => {
                onAct('template');
              })}
              {tool(
                t('Copy resources from here'),
                <ArrowsLeftRightIcon aria-hidden="true" />,
                () => {
                  onAct('copy');
                },
              )}
              {tool(t('Export to a file'), <DownloadSimpleIcon aria-hidden="true" />, () => {
                onAct('export');
              })}
              {tool(
                'Delete',
                <TrashIcon aria-hidden="true" />,
                () => {
                  onAct('delete');
                },
                true,
              )}
            </ul>
          )}
        </div>
      </footer>
    </article>
  );
}

function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}): ReactElement {
  return (
    <Modal open={open} onClose={onClose} label={t('New project')} wide>
      <NewProjectForm onClose={onClose} onCreated={onCreated} />
    </Modal>
  );
}

/** Mounted each time the dialog opens, so it always starts empty. */
function NewProjectForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}): ReactElement {
  const imp = useImp();
  const [name, setName] = useState('');
  const [mode, setMode] = useState(imp.modes[0]?.id ?? 'movie');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const templates = useLive(['template-index/'], async (current) =>
    Templates.parse(await runCommand(current, 'project.template.list', {})),
  );
  const available = (templates.data?.templates ?? []).filter((t) => t.mode === mode);
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    runCommand(imp, 'project.create', {
      name: name.trim(),
      mode,
      ...(templateId === null ? {} : { templateId }),
    }).then(
      (project) => {
        onCreated(Project.parse(project));
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };
  const option = (
    id: string | null,
    title: string,
    summary: string,
    tag?: string,
  ): ReactElement => (
    <label key={id ?? 'empty'} className="template-option" aria-label={title}>
      <input
        type="radio"
        name="template"
        checked={templateId === id}
        onChange={() => {
          setTemplateId(id);
        }}
      />
      <span className="template-card">
        <span className="row spread">
          <strong>{title}</strong>
          {tag !== undefined && <span className="tag neutral">{tag}</span>}
        </span>
        <span className="muted">{summary}</span>
      </span>
    </label>
  );
  return (
    <form className="modal-body stack" onSubmit={submit}>
      <div className="eyebrow">{t('New project')}</div>
      <h2>{t('What are you making?')}</h2>
      <div className="row wrap">
        <div className="field">
          <label htmlFor="new-project-name">{t('Working title')}</label>
          <input
            id="new-project-name"
            className="input"
            value={name}
            placeholder={t('The Lighthouse Keeper')}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        {imp.modes.length > 1 && (
          <div className="field">
            <label htmlFor="new-project-mode">{t('Mode')}</label>
            <select
              id="new-project-mode"
              className="select"
              value={mode}
              onChange={(event) => {
                setMode(event.target.value);
                setTemplateId(null);
              }}
            >
              {imp.modes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {tx(candidate.name)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <fieldset className="templates">
        <legend className="eyebrow">{t('Start from')}</legend>
        {option(null, t('Empty'), t('Nothing yet: write it from the first line.'))}
        {available.map((template) =>
          option(
            template.id,
            tx(template.name),
            tx(template.summary),
            template.builtIn ? undefined : t('Yours'),
          ),
        )}
      </fieldset>
      <Problem text={error} />
      <div className="row spread">
        <button type="button" className="button quiet" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="button primary" disabled={name.trim() === ''}>
          <FilmSlateIcon aria-hidden="true" /> {t('Create project')}
        </button>
      </div>
    </form>
  );
}

function SaveTemplateDialog({
  project,
  onClose,
  onSaved,
}: {
  project: OverviewEntry | null;
  onClose: () => void;
  onSaved: (template: Template) => void;
}): ReactElement {
  return (
    <Modal open={project !== null} onClose={onClose} label={t('Save as template')}>
      {project !== null && (
        <SaveTemplateForm project={project} onClose={onClose} onSaved={onSaved} />
      )}
    </Modal>
  );
}

function SaveTemplateForm({
  project,
  onClose,
  onSaved,
}: {
  project: OverviewEntry;
  onClose: () => void;
  onSaved: (template: Template) => void;
}): ReactElement {
  const imp = useImp();
  const [name, setName] = useState(t('{name} template', { name: project.name }));
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    runCommand(imp, 'project.template.save', {
      projectId: project.id,
      name: name.trim(),
      summary: summary.trim(),
    }).then(
      (saved) => {
        onSaved(Template.parse(saved));
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };
  return (
    <form className="modal-body stack" onSubmit={submit}>
      <div className="eyebrow">{t('Save as template')}</div>
      <h2>{t('Start future projects from this one')}</h2>
      <p className="muted">
        {t(
          'Everything in “{name}” is copied into the template, files included. Later changes to the project do not change it.',
          { name: project.name },
        )}
      </p>
      <div className="field">
        <label htmlFor="template-name">{t('Template name')}</label>
        <input
          id="template-name"
          className="input"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="template-summary">{t('What a new project starts with')}</label>
        <textarea
          id="template-summary"
          className="input"
          rows={2}
          value={summary}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
        />
      </div>
      <Problem text={error} />
      <div className="row spread">
        <button type="button" className="button quiet" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="button primary" disabled={name.trim() === ''}>
          <BookmarkSimpleIcon aria-hidden="true" /> {t('Save template')}
        </button>
      </div>
    </form>
  );
}

function ConfirmDelete({
  project,
  onClose,
  onDeleted,
}: {
  project: OverviewEntry | null;
  onClose: () => void;
  onDeleted: (name: string) => void;
}): ReactElement {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={project !== null} onClose={onClose} label={t('Delete project')}>
      <div className="modal-body stack">
        <div className="eyebrow">{t('Delete project')}</div>
        <h2>{t('Delete “{name}”?', { name: project?.name ?? '' })}</h2>
        <p className="muted">
          {t(
            'Its script, cast, shots, sound and cut go, files included. This cannot be undone. Export it first if you may want it back.',
          )}
        </p>
        <Problem text={error} />
        <div className="row spread">
          <button className="button quiet" onClick={onClose}>
            {t('Keep it')}
          </button>
          <button
            className="button danger"
            onClick={() => {
              if (project === null) return;
              runCommand(imp, 'project.delete', { projectId: project.id }).then(
                () => {
                  onDeleted(project.name);
                },
                (reason: unknown) => {
                  setError(messageOf(reason));
                },
              );
            }}
          >
            <TrashIcon aria-hidden="true" /> {t('Delete for good')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Picks resources in one project and copies them into another. */
function CopyDialog(props: {
  open: boolean;
  projects: readonly OverviewEntry[];
  initialFrom: string | null;
  initialTo: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}): ReactElement {
  return (
    <Modal open={props.open} onClose={props.onClose} label={t('Copy between projects')} wide>
      <CopyForm {...props} />
    </Modal>
  );
}

function CopyForm({
  projects,
  initialFrom,
  initialTo,
  onClose,
  onDone,
}: {
  projects: readonly OverviewEntry[];
  initialFrom: string | null;
  initialTo: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}): ReactElement {
  const imp = useImp();
  const [from, setFrom] = useState<string>(() => initialFrom ?? projects[0]?.id ?? '');
  const [to, setTo] = useState<string>(() => {
    const first = initialFrom ?? projects[0]?.id ?? '';
    const sourceMode = projects.find((p) => p.id === first)?.mode;
    return initialTo !== null && initialTo !== first
      ? initialTo
      : (projects.find((p) => p.id !== first && p.mode === sourceMode)?.id ?? '');
  });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Each list remembers whose it is, so a list can never be shown for the wrong project.
  const [sourceList, setSource] = useState<Listed | null>(null);
  const [targetList, setTarget] = useState<Listed | null>(null);
  const source = sourceList?.projectId === from ? sourceList.data : null;
  const target = targetList?.projectId === to ? targetList.data : null;

  useEffect(() => {
    if (from === '') return;
    let active = true;
    runCommand(imp, 'project.resources.list', { projectId: from }).then(
      (listed) => {
        if (active) setSource({ projectId: from, data: Resources.parse(listed) });
      },
      (reason: unknown) => {
        if (active) setError(messageOf(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [imp, from]);

  useEffect(() => {
    if (to === '') return;
    let active = true;
    runCommand(imp, 'project.resources.list', { projectId: to }).then(
      (listed) => {
        if (active) setTarget({ projectId: to, data: Resources.parse(listed) });
      },
      (reason: unknown) => {
        if (active) setError(messageOf(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [imp, to]);

  const kinds = source?.kinds ?? [];
  const items = source?.items ?? [];
  const chosen = items.filter((item) => picked.has(itemKey(item)));
  const parentKinds = [
    ...new Set(
      chosen
        .map((item) => kinds.find((k) => k.id === item.kind))
        .filter((k) => k?.needsParent === true)
        .map((k) => k?.parentKind ?? ''),
    ),
  ];
  const parentKind = parentKinds[0];
  const parents = (target?.items ?? []).filter((item) => item.kind === parentKind);
  const toggle = (item: ResourceItem): void => {
    const next = new Set(picked);
    const key = itemKey(item);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const others = projects.filter(
    (p) => p.id !== from && p.mode === projects.find((q) => q.id === from)?.mode,
  );
  const ready =
    from !== '' && to !== '' && chosen.length > 0 && (parentKind === undefined || parentId !== '');

  const submit = (): void => {
    setError(null);
    runCommand(imp, 'project.resources.copy', {
      fromProjectId: from,
      toProjectId: to,
      items: chosen.map(({ kind, id }) => ({ kind, id })),
      ...(parentKind === undefined ? {} : { parentId }),
    }).then(
      (raw) => {
        const result = CopyResult.parse(raw);
        const toName = projects.find((p) => p.id === to)?.name ?? '';
        onDone(
          result.status === 'copied'
            ? t('Copied {value} into “{toName}”.', {
                value: String(result.outcomes?.length ?? 0),
                toName,
              })
            : t('Some of it is already in “{toName}”: say what to do.', { toName }),
        );
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return (
    <div className="modal-body stack">
      <div className="eyebrow">{t('Copy between projects')}</div>
      <h2>{t('Bring work from one project into another')}</h2>
      <div className="row wrap copy-ends">
        <div className="field">
          <label htmlFor="copy-from">{t('From')}</label>
          <select
            id="copy-from"
            className="select"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPicked(new Set());
              if (event.target.value === to) setTo('');
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <ArrowsLeftRightIcon aria-hidden="true" className="copy-arrow" />
        <div className="field">
          <label htmlFor="copy-to">{t('Into')}</label>
          <select
            id="copy-to"
            className="select"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setParentId('');
            }}
          >
            <option value="" disabled>
              {others.length === 0 ? t('No other project of this mode') : t('Pick a project')}
            </option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="resource-list" role="group" aria-label={t('What to copy')}>
        {kinds.map((kind) => {
          const ofKind = items.filter((item) => item.kind === kind.id);
          if (ofKind.length === 0) return null;
          return (
            <section key={kind.id}>
              <h3 className="eyebrow">{tx(kind.plural)}</h3>
              {ofKind.map((item) => (
                <label key={itemKey(item)} className="resource">
                  <input
                    type="checkbox"
                    checked={picked.has(itemKey(item))}
                    onChange={() => {
                      toggle(item);
                    }}
                  />
                  <span>
                    <span>{item.name}</span>
                    {item.detail !== '' && <span className="muted"> · {item.detail}</span>}
                  </span>
                </label>
              ))}
            </section>
          );
        })}
        {source !== null && items.length === 0 && (
          <p className="muted">{t('There is nothing in this project to copy yet.')}</p>
        )}
      </div>
      {parentKind !== undefined && (
        <div className="field">
          <label htmlFor="copy-parent">
            {t('Where it goes in the target ({kind})', {
              kind: tx(kinds.find((k) => k.id === parentKind)?.label ?? parentKind),
            })}
          </label>
          <select
            id="copy-parent"
            className="select"
            value={parentId}
            onChange={(event) => {
              setParentId(event.target.value);
            }}
          >
            <option value="" disabled>
              {parents.length === 0 ? t('The target has none yet') : t('Pick one')}
            </option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="muted small">
        {t(
          'What the picks need comes along, such as the characters in a scene’s shots. If something is already there, you are asked what to do.',
        )}
      </p>
      <Problem text={error} />
      <div className="row spread">
        <button className="button quiet" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="button primary" disabled={!ready} onClick={submit}>
          <ArrowsLeftRightIcon aria-hidden="true" /> {t('Copy')}{' '}
          {chosen.length === 0 ? '' : String(chosen.length)}
        </button>
      </div>
    </div>
  );
}

function defaultChoice(item: PlannedItem, suggestion: CollisionChoice | null): CollisionChoice {
  const choices = item.collision?.choices ?? [];
  if (suggestion !== null && choices.includes(suggestion)) return suggestion;
  if (item.reason === 'picked' && choices.includes('keepBoth')) return 'keepBoth';
  return 'skip';
}

function matchText(item: PlannedItem): string {
  const collision = item.collision;
  if (collision === null) return '';
  if (collision.match === 'singleton') return t('The target has its own already.');
  if (collision.match === 'id')
    return t('“{targetName}” there is the same one, copied before.', {
      targetName: collision.targetName,
    });
  return t('“{targetName}” there has the same name.', { targetName: collision.targetName });
}

/**
 * The question a copy asks when something is already in the target. It is
 * put to the person whoever started the copy, and only they can answer it.
 */
export function CopyQuestions(): ReactElement | null {
  const pending = useLive(['copy-requests/'], async (current) =>
    Requests.parse(await runCommand(current, 'project.resources.request.list', {})),
  );
  const request = pending.data?.requests[0] ?? null;
  if (request === null) return null;
  // A new plan (the projects changed while the question waited) starts the choices over.
  return <CopyQuestion key={`${request.id} ${JSON.stringify(request.plan)}`} request={request} />;
}

function CopyQuestion({ request }: { request: CopyRequest }): ReactElement {
  const imp = useImp();
  const [choices, setChoices] = useState<Record<string, CollisionChoice>>(() =>
    Object.fromEntries(
      request.plan
        .filter((item) => item.collision !== null)
        .map((item) => [itemKey(item), defaultChoice(item, request.suggestion)]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const collisions = request.plan.filter((item) => item.collision !== null);
  const clean = request.plan.filter((item) => item.collision === null);
  const resolve = (cancel: boolean): void => {
    setBusy(true);
    setError(null);
    runCommand(imp, 'project.resources.request.resolve', {
      requestId: request.id,
      choices,
      cancel,
    }).then(
      () => {
        setBusy(false);
      },
      (reason: unknown) => {
        setBusy(false);
        setError(messageOf(reason));
      },
    );
  };
  const setAll = (choice: CollisionChoice): void => {
    setChoices(
      Object.fromEntries(
        collisions.map((item) => [
          itemKey(item),
          item.collision?.choices.includes(choice) === true
            ? choice
            : (choices[itemKey(item)] ?? 'skip'),
        ]),
      ),
    );
  };
  const count = request.plan.length;
  const intro =
    request.requestedBy.kind === 'agent'
      ? tn(
          count,
          '{name} wants to copy {count} thing. Say what happens to each one that meets its match.',
          '{name} wants to copy {count} things. Say what happens to each one that meets its match.',
          {
            name: tx(
              request.requestedBy.role
                .replace(/-/g, ' ')
                .replace(/^./, (letter) => letter.toUpperCase()),
            ),
          },
        )
      : tn(
          count,
          'You are copying {count} thing. Say what happens to each one that meets its match.',
          'You are copying {count} things. Say what happens to each one that meets its match.',
        );

  return (
    <Modal open onClose={() => undefined} label={t('Already in the target')} wide>
      <div className="modal-body stack">
        <div className="eyebrow">
          {t('Copy from “{fromName}” into “{toName}”', {
            fromName: request.fromName,
            toName: request.toName,
          })}
        </div>
        <h2>
          {tn(
            collisions.length,
            'One of these is already there',
            '{count} of these are already there',
          )}
        </h2>
        <p className="muted">{intro}</p>
        {request.note !== '' && <blockquote className="copy-note">{request.note}</blockquote>}
        <ul className="collisions">
          {collisions.map((item) => {
            const key = itemKey(item);
            return (
              <li key={key} className="collision">
                <div>
                  <strong>{item.name}</strong>{' '}
                  <span className="muted">
                    {tx(item.kind.charAt(0).toUpperCase() + item.kind.slice(1))}
                    {item.reason === 'needed' && item.neededBy !== null
                      ? t(', needed by {neededBy}', { neededBy: item.neededBy })
                      : ''}
                  </span>
                  <div className="muted small">{matchText(item)}</div>
                </div>
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label={t('What to do with {name}', { name: item.name })}
                >
                  {(item.collision?.choices ?? []).map((choice) => (
                    <label key={choice} data-choice={choice}>
                      <input
                        type="radio"
                        name={`choice-${key}`}
                        checked={choices[key] === choice}
                        onChange={() => {
                          setChoices({ ...choices, [key]: choice });
                        }}
                      />
                      <span>
                        {choice === 'skip' && item.reason === 'needed'
                          ? t('Use theirs')
                          : CHOICE_LABELS[choice]}
                      </span>
                    </label>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        {clean.length > 0 && (
          <p className="muted small">
            {t('Copied as they are: {value}.', {
              value: clean.map((item) => item.name).join(', '),
            })}
          </p>
        )}
        <div className="row wrap set-all">
          <span className="muted small">{t('Set all to')}</span>
          {(['overwrite', 'keepBoth', 'skip'] as const).map((choice) => (
            <button
              key={choice}
              className="button small"
              onClick={() => {
                setAll(choice);
              }}
            >
              {CHOICE_LABELS[choice]}
            </button>
          ))}
        </div>
        <Problem text={error} />
        <div className="row spread">
          <button
            className="button quiet"
            disabled={busy}
            onClick={() => {
              resolve(true);
            }}
          >
            {t('Cancel the copy')}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              resolve(false);
            }}
          >
            <ArrowsLeftRightIcon aria-hidden="true" /> {t('Copy')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The start screen: every project with how far it has come, and what can be done with it. */
export function ProjectsView({
  onOpen,
  creating,
  onCreatingChange,
}: {
  onOpen: (projectId: string) => void;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}): ReactElement {
  const imp = useImp();
  const overview = useLive(
    ['project-index/', 'projects/', 'settings/project.current'],
    async (current) => Overview.parse(await runCommand(current, 'project.overview', {})),
  );
  const templates = useLive(['template-index/'], async (current) =>
    Templates.parse(await runCommand(current, 'project.template.list', {})),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateFor, setTemplateFor] = useState<OverviewEntry | null>(null);
  const [deleting, setDeleting] = useState<OverviewEntry | null>(null);
  const [copy, setCopy] = useState<{ from: string | null } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const projects = overview.data?.projects ?? [];
  const currentId = overview.data?.currentProjectId ?? null;
  const saved = (templates.data?.templates ?? []).filter((t) => !t.builtIn);
  const help = useHelpState();
  // The sample is for learning: offered while tips are on, or when there is nothing else to open.
  const samples = (templates.data?.templates ?? []).filter((t) => t.sample);
  const offerSamples = help.data?.enabled !== false || projects.length === 0;

  const openSample = (template: Template): void => {
    setError(null);
    setNotice(t('Opening the sample “{name}”…', { name: tx(template.name) }));
    runCommand(imp, 'project.create', {
      name: tx(template.name),
      mode: template.mode,
      templateId: template.id,
    }).then((made) => {
      setNotice(null);
      onOpen(Project.parse(made).id);
    }, fail);
  };

  const fail = (reason: unknown): void => {
    setNotice(null);
    setError(messageOf(reason));
  };
  const act = (
    entry: OverviewEntry,
    action: 'duplicate' | 'template' | 'export' | 'copy' | 'delete',
  ): void => {
    setError(null);
    if (action === 'duplicate') {
      setNotice(t('Duplicating “{name}”…', { name: entry.name }));
      runCommand(imp, 'project.duplicate', { projectId: entry.id }).then((made) => {
        setNotice(
          t('Made “{name}”, a copy of “{name2}”.', {
            name: Project.parse(made).name,
            name2: entry.name,
          }),
        );
      }, fail);
    } else if (action === 'export') {
      let size = 0;
      saveFileAs(
        {
          suggestedName: fileNameFor(entry.name),
          mediaType: 'application/zip',
          description: t('Imp project'),
        },
        async () => {
          setNotice(t('Packing “{name}”…', { name: entry.name }));
          const exported = Exported.parse(
            await runCommand(imp, 'project.export', { projectId: entry.id }),
          );
          const file = await imp.blob(exported.fileKey, true);
          if (file === undefined) throw new Error(t('The exported file went missing.'));
          size = exported.sizeBytes;
          return file.bytes;
        },
      )
        .then((outcome) => {
          setNotice(
            outcome.saved
              ? t('Saved {name} ({size}).', { name: outcome.name, size: sizeOf(size) })
              : null,
          );
        })
        .catch(fail);
    } else if (action === 'template') {
      setTemplateFor(entry);
    } else if (action === 'copy') {
      setCopy({ from: entry.id });
    } else {
      setDeleting(entry);
    }
  };

  const importFile = (file: File): void => {
    setError(null);
    setNotice(t('Reading {name}…', { name: file.name }));
    file
      .arrayBuffer()
      .then((buffer) => imp.upload(new Uint8Array(buffer), file.type || 'application/zip'))
      .then((fileKey) => runCommand(imp, 'project.import', { fileKey }))
      .then((raw) => {
        const project = Project.parse(raw);
        setNotice(t('Imported “{name}”.', { name: project.name }));
      })
      .catch(fail);
  };

  return (
    <>
      <div className="view-head spread projects-head">
        <div className="stack tight">
          <ImpAlias />
          <h1>{t('Projects')}</h1>
          <span className="muted">
            {projects.length === 0
              ? t(
                  'Nothing here yet, and an idle imp gets ideas. Start one, or bring one in from a file.',
                )
              : tn(
                  projects.length,
                  '{count} project, most recently opened first.',
                  '{count} projects, most recently opened first.',
                )}
          </span>
        </div>
        <div className="row wrap">
          <BackupButton />
          <button
            className="button"
            onClick={() => picker.current?.click()}
            title={t('Make a project from an .imp.zip file')}
          >
            <UploadSimpleIcon aria-hidden="true" /> {t('Import')}
          </button>
          <input
            ref={picker}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label={t('Project file to import')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) importFile(file);
            }}
          />
          <button
            className="button"
            disabled={projects.length < 2}
            onClick={() => {
              setCopy({ from: null });
            }}
          >
            <ArrowsLeftRightIcon aria-hidden="true" /> {t('Copy between projects')}
          </button>
          <button
            className="button primary"
            onClick={() => {
              onCreatingChange(true);
            }}
          >
            <PlusIcon aria-hidden="true" /> {t('New project')}
          </button>
        </div>
      </div>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <Problem text={overview.error ?? error} />
      <div className="project-grid">
        {projects.map((entry) => (
          <ProjectCard
            key={entry.id}
            entry={entry}
            current={entry.id === currentId}
            onOpen={() => {
              onOpen(entry.id);
            }}
            onAct={(action) => {
              act(entry, action);
            }}
          />
        ))}
        <button
          className="project-new"
          onClick={() => {
            onCreatingChange(true);
          }}
        >
          <PlusIcon aria-hidden="true" size={28} />
          <span>{t('New project')}</span>
          <span className="muted small">{t('Empty, or from a template')}</span>
        </button>
        {offerSamples &&
          samples.map((template) => (
            <button
              key={template.id}
              className="project-new project-sample"
              onClick={() => {
                openSample(template);
              }}
            >
              <LighthouseIcon aria-hidden="true" size={28} />
              <span>{t('Open the sample film')}</span>
              <span className="muted small">
                {t('“{name}”: written down to every shot. Free to open; take it apart.', {
                  name: template.name,
                })}
              </span>
            </button>
          ))}
      </div>
      {saved.length > 0 && (
        <section className="stack">
          <h2>{t('Your templates')}</h2>
          <ul className="saved-templates">
            {saved.map((template) => (
              <li key={template.id} className="row spread">
                <span>
                  <strong>{template.name}</strong>
                  <span className="muted">
                    {' '}
                    ·{' '}
                    {template.summary === ''
                      ? t('from “{name}”', { name: template.sourceProjectName ?? '' })
                      : template.summary}
                  </span>
                </span>
                <button
                  className="button quiet icon danger-quiet"
                  aria-label={t('Delete template {name}', { name: template.name })}
                  title={t('Delete template')}
                  onClick={() => {
                    runCommand(imp, 'project.template.delete', { templateId: template.id }).then(
                      () => {
                        setNotice(t('Deleted the template “{name}”.', { name: template.name }));
                      },
                      fail,
                    );
                  }}
                >
                  <TrashIcon aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NewProjectDialog
        open={creating}
        onClose={() => {
          onCreatingChange(false);
        }}
        onCreated={(project) => {
          onCreatingChange(false);
          onOpen(project.id);
        }}
      />
      <SaveTemplateDialog
        project={templateFor}
        onClose={() => {
          setTemplateFor(null);
        }}
        onSaved={(template) => {
          setTemplateFor(null);
          setNotice(
            t('Saved the template “{name}”. New projects can start from it.', {
              name: template.name,
            }),
          );
        }}
      />
      <ConfirmDelete
        project={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDeleted={(name) => {
          setDeleting(null);
          setNotice(t('Deleted “{name}”.', { name }));
        }}
      />
      <CopyDialog
        open={copy !== null}
        projects={projects}
        initialFrom={copy?.from ?? null}
        initialTo={copy?.from === currentId ? null : currentId}
        onClose={() => {
          setCopy(null);
        }}
        onDone={(message) => {
          setCopy(null);
          setNotice(message);
        }}
      />
    </>
  );
}
