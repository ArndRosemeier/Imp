import {
  CopyRequest,
  itemKey,
  Project,
  ProjectSummary,
  ResourceItem,
  ResourceKindInfo,
  Template,
  type CollisionChoice,
  type PlannedItem,
} from '@imp/core';
import {
  ArrowsLeftRightIcon,
  BookmarkSimpleIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
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
import { Problem, useBlobUrl } from './movie.js';

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
  overwrite: 'Overwrite',
  keepBoth: 'Keep both',
  skip: 'Skip',
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
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
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
  return 'just now';
}

function sizeOf(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Saves bytes as a file on the person's computer. */
export function saveFile(bytes: Uint8Array, mediaType: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
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
      <span className="poster-progress" title="Overall progress">
        {Math.round(entry.progress * 100)}%
      </span>
    </div>
  );
}

function PosterImage({ blobKey }: { blobKey: string }): ReactElement {
  const url = useBlobUrl(blobKey);
  return url === null ? <span className="poster-cell" /> : <img src={url} alt="" />;
}

function StageMeter({ entry }: { entry: OverviewEntry }): ReactElement | null {
  const stages = entry.summary?.stages ?? [];
  if (stages.length === 0) return null;
  return (
    <ul className="stages" aria-label="Progress by stage">
      {stages.map((stage) => {
        const share = stage.total === 0 ? 0 : stage.done / stage.total;
        return (
          <li key={stage.id} title={stage.note}>
            <span className="stage-name">{stage.name}</span>
            <span className="stage-bar" aria-hidden="true">
              <span style={{ width: `${String(Math.round(share * 100))}%` }} />
            </span>
            <span className="stage-count">
              {stage.total === 0 ? '–' : `${String(stage.done)}/${String(stage.total)}`}
            </span>
            <span className="sr-only">{stage.note}</span>
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
  const tool = (
    label: string,
    icon: ReactElement,
    action: () => void,
    danger = false,
  ): ReactElement => (
    <button
      className={danger ? 'button quiet icon danger-quiet' : 'button quiet icon'}
      aria-label={`${label}: ${entry.name}`}
      title={label}
      onClick={action}
    >
      {icon}
    </button>
  );
  return (
    <article className="project-card" aria-current={current ? 'true' : undefined}>
      <button className="project-open" onClick={onOpen} aria-label={`Open ${entry.name}`}>
        <Poster entry={entry} />
      </button>
      <div className="project-body">
        <div className="row spread project-title-row">
          {renaming ? (
            <form onSubmit={rename} className="project-rename">
              <input
                className="input"
                aria-label="Project name"
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
          {current && <span className="tag accent">Open</span>}
        </div>
        <p className="project-headline muted">
          {entry.summary?.headline !== undefined && entry.summary.headline !== ''
            ? entry.summary.headline
            : 'No logline yet.'}
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
        <span className="row tools">
          {tool('Rename', <PencilSimpleIcon aria-hidden="true" />, () => {
            setName(entry.name);
            setRenaming(true);
          })}
          {tool('Duplicate', <CopyIcon aria-hidden="true" />, () => {
            onAct('duplicate');
          })}
          {tool('Save as template', <BookmarkSimpleIcon aria-hidden="true" />, () => {
            onAct('template');
          })}
          {tool('Copy resources from here', <ArrowsLeftRightIcon aria-hidden="true" />, () => {
            onAct('copy');
          })}
          {tool('Export to a file', <DownloadSimpleIcon aria-hidden="true" />, () => {
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
        </span>
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
    <Modal open={open} onClose={onClose} label="New project" wide>
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
      <div className="eyebrow">New project</div>
      <h2>What are you making?</h2>
      <div className="row wrap">
        <div className="field">
          <label htmlFor="new-project-name">Working title</label>
          <input
            id="new-project-name"
            className="input"
            value={name}
            placeholder="The Lighthouse Keeper"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        {imp.modes.length > 1 && (
          <div className="field">
            <label htmlFor="new-project-mode">Mode</label>
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
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <fieldset className="templates">
        <legend className="eyebrow">Start from</legend>
        {option(null, 'Empty', 'Nothing yet: write it from the first line.')}
        {available.map((t) => option(t.id, t.name, t.summary, t.builtIn ? undefined : 'Yours'))}
      </fieldset>
      <Problem text={error} />
      <div className="row spread">
        <button type="button" className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={name.trim() === ''}>
          <FilmSlateIcon aria-hidden="true" /> Create project
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
    <Modal open={project !== null} onClose={onClose} label="Save as template">
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
  const [name, setName] = useState(`${project.name} template`);
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
      <div className="eyebrow">Save as template</div>
      <h2>Start future projects from this one</h2>
      <p className="muted">
        Everything in “{project.name}” is copied into the template, files included. Later changes to
        the project do not change it.
      </p>
      <div className="field">
        <label htmlFor="template-name">Template name</label>
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
        <label htmlFor="template-summary">What a new project starts with</label>
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
          Cancel
        </button>
        <button className="button primary" disabled={name.trim() === ''}>
          <BookmarkSimpleIcon aria-hidden="true" /> Save template
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
    <Modal open={project !== null} onClose={onClose} label="Delete project">
      <div className="modal-body stack">
        <div className="eyebrow">Delete project</div>
        <h2>Delete “{project?.name}”?</h2>
        <p className="muted">
          Its script, cast, shots, sound and cut go, files included. This cannot be undone. Export
          it first if you may want it back.
        </p>
        <Problem text={error} />
        <div className="row spread">
          <button className="button quiet" onClick={onClose}>
            Keep it
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
            <TrashIcon aria-hidden="true" /> Delete for good
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
    <Modal open={props.open} onClose={props.onClose} label="Copy between projects" wide>
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
            ? `Copied ${String(result.outcomes?.length ?? 0)} into “${toName}”.`
            : `Some of it is already in “${toName}”: say what to do.`,
        );
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return (
    <div className="modal-body stack">
      <div className="eyebrow">Copy between projects</div>
      <h2>Bring work from one project into another</h2>
      <div className="row wrap copy-ends">
        <div className="field">
          <label htmlFor="copy-from">From</label>
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
          <label htmlFor="copy-to">Into</label>
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
              {others.length === 0 ? 'No other project of this mode' : 'Pick a project'}
            </option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="resource-list" role="group" aria-label="What to copy">
        {kinds.map((kind) => {
          const ofKind = items.filter((item) => item.kind === kind.id);
          if (ofKind.length === 0) return null;
          return (
            <section key={kind.id}>
              <h3 className="eyebrow">{kind.plural}</h3>
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
          <p className="muted">There is nothing in this project to copy yet.</p>
        )}
      </div>
      {parentKind !== undefined && (
        <div className="field">
          <label htmlFor="copy-parent">
            Into which {kinds.find((k) => k.id === parentKind)?.label.toLowerCase() ?? parentKind}{' '}
            of the target
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
              {parents.length === 0 ? 'The target has none yet' : 'Pick one'}
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
        What the picks need comes along, such as the characters in a scene’s shots. If something is
        already there, you are asked what to do.
      </p>
      <Problem text={error} />
      <div className="row spread">
        <button className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={!ready} onClick={submit}>
          <ArrowsLeftRightIcon aria-hidden="true" /> Copy{' '}
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
  if (collision.match === 'singleton') return 'The target has its own already.';
  if (collision.match === 'id')
    return `“${collision.targetName}” there is the same one, copied before.`;
  return `“${collision.targetName}” there has the same name.`;
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
  const who =
    request.requestedBy.kind === 'agent'
      ? `${request.requestedBy.role.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} wants to copy`
      : 'You are copying';

  return (
    <Modal open onClose={() => undefined} label="Already in the target" wide>
      <div className="modal-body stack">
        <div className="eyebrow">
          Copy from “{request.fromName}” into “{request.toName}”
        </div>
        <h2>
          {collisions.length === 1
            ? 'One of these is already there'
            : `${String(collisions.length)} of these are already there`}
        </h2>
        <p className="muted">
          {who} {String(request.plan.length)} {request.plan.length === 1 ? 'thing' : 'things'}. Say
          what happens to each one that meets its match.
        </p>
        {request.note !== '' && <blockquote className="copy-note">{request.note}</blockquote>}
        <ul className="collisions">
          {collisions.map((item) => {
            const key = itemKey(item);
            return (
              <li key={key} className="collision">
                <div>
                  <strong>{item.name}</strong>{' '}
                  <span className="muted">
                    {item.kind}
                    {item.reason === 'needed' && item.neededBy !== null
                      ? `, needed by ${item.neededBy}`
                      : ''}
                  </span>
                  <div className="muted small">{matchText(item)}</div>
                </div>
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label={`What to do with ${item.name}`}
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
                          ? 'Use theirs'
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
            Copied as they are: {clean.map((item) => item.name).join(', ')}.
          </p>
        )}
        <div className="row wrap set-all">
          <span className="muted small">Set all to</span>
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
            Cancel the copy
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              resolve(false);
            }}
          >
            <ArrowsLeftRightIcon aria-hidden="true" /> Copy
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
      setNotice(`Duplicating “${entry.name}”…`);
      runCommand(imp, 'project.duplicate', { projectId: entry.id }).then((made) => {
        setNotice(`Made “${Project.parse(made).name}”, a copy of “${entry.name}”.`);
      }, fail);
    } else if (action === 'export') {
      setNotice(`Packing “${entry.name}”…`);
      runCommand(imp, 'project.export', { projectId: entry.id })
        .then(async (raw) => {
          const exported = Exported.parse(raw);
          const file = await imp.blob(exported.fileKey, true);
          if (file === undefined) throw new Error('The exported file went missing.');
          saveFile(file.bytes, file.mediaType, exported.fileName);
          setNotice(`Saved ${exported.fileName} (${sizeOf(exported.sizeBytes)}).`);
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
    setNotice(`Reading ${file.name}…`);
    file
      .arrayBuffer()
      .then((buffer) => imp.upload(new Uint8Array(buffer), file.type || 'application/zip'))
      .then((fileKey) => runCommand(imp, 'project.import', { fileKey }))
      .then((raw) => {
        const project = Project.parse(raw);
        setNotice(`Imported “${project.name}”.`);
      })
      .catch(fail);
  };

  return (
    <>
      <div className="view-head spread projects-head">
        <div className="stack tight">
          <h1>Projects</h1>
          <span className="muted">
            {projects.length === 0
              ? 'Nothing here yet. Start one, or bring one in from a file.'
              : `${String(projects.length)} ${projects.length === 1 ? 'project' : 'projects'}, most recently opened first.`}
          </span>
        </div>
        <div className="row wrap">
          <button
            className="button"
            onClick={() => picker.current?.click()}
            title="Make a project from an .imp.zip file"
          >
            <UploadSimpleIcon aria-hidden="true" /> Import
          </button>
          <input
            ref={picker}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label="Project file to import"
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
            <ArrowsLeftRightIcon aria-hidden="true" /> Copy between projects
          </button>
          <button
            className="button primary"
            onClick={() => {
              onCreatingChange(true);
            }}
          >
            <PlusIcon aria-hidden="true" /> New project
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
          <span>New project</span>
          <span className="muted small">Empty, or from a template</span>
        </button>
      </div>
      {saved.length > 0 && (
        <section className="stack">
          <h2>Your templates</h2>
          <ul className="saved-templates">
            {saved.map((t) => (
              <li key={t.id} className="row spread">
                <span>
                  <strong>{t.name}</strong>
                  <span className="muted">
                    {' '}
                    · {t.summary === '' ? `from “${t.sourceProjectName ?? ''}”` : t.summary}
                  </span>
                </span>
                <button
                  className="button quiet icon danger-quiet"
                  aria-label={`Delete template ${t.name}`}
                  title="Delete template"
                  onClick={() => {
                    runCommand(imp, 'project.template.delete', { templateId: t.id }).then(() => {
                      setNotice(`Deleted the template “${t.name}”.`);
                    }, fail);
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
          setNotice(`Saved the template “${template.name}”. New projects can start from it.`);
        }}
      />
      <ConfirmDelete
        project={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDeleted={(name) => {
          setDeleting(null);
          setNotice(`Deleted “${name}”.`);
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
