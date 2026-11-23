import { CrewMember, GLOBAL_COORDINATOR_ROLE } from '@imp/agents';
import { AlwaysAllowed } from './Approvals.js';
import { ActivityEntry } from '@imp/core';
import {
  CaretUpIcon,
  DownloadSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import { useId, useState, type ReactElement, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { servedByLocalServer } from '../host/served.js';
import { ConfirmButton } from './Field.js';
import { ModelPanel } from './model-bar.js';
import { AGENTS_MODEL_SETTING, chooseModel, ModelChoice } from './model-choice.js';
import { NumberField } from './NumberField.js';
import { useModelSetting, type Act } from './movie.js';
import {
  EFFECT_MODEL_SETTING,
  IMAGE_MODEL_SETTING,
  MUSIC_MODEL_SETTING,
  SPEECH_MODEL_SETTING,
  VIDEO_MODEL_SETTING,
} from '@imp/mode-movie';
import { TRANSCRIPTION_MODEL_SETTING } from '@imp/audio';
import { TipsSwitch } from './help/HelpPanel.js';
import { openHelp } from './help/help.js';
import { FfmpegOffer } from './FfmpegOffer.js';
import { BackupPanel } from './backup.js';
import { saveFileAs } from './save-file.js';
import { INTERNAL_SETTINGS, MODEL_SETTINGS, settingLabel } from './settings-labels.js';
import { currentLanguage, t, tx } from '../i18n/i18n.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { AllowanceFields, formatUsd } from './spend.js';

const CrewList = z.object({ crew: z.array(CrewMember) });
const RoleList = z.object({
  roles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      custom: z.boolean(),
      extra: z.boolean().optional(),
      modelInput: z.array(z.string()).default([]),
    }),
  ),
  extras: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })),
});
const ActivityList = z.object({ entries: z.array(ActivityEntry) });
const SettingList = z.object({ settings: z.array(z.object({ key: z.string(), value: z.json() })) });

export function CrewView(): ReactElement {
  const imp = useImp();
  const crew = useLive(['crew/'], async (current) =>
    CrewList.parse(await runCommand(current, 'crew.list', {})),
  );
  const roles = useLive(['roles/', 'roles-added/', 'crew/'], async (current) =>
    RoleList.parse(await runCommand(current, 'crew.roles', {})),
  );
  const coordinator = useLive(['settings/'], async (current) => {
    const read = async (key: string): Promise<unknown> =>
      z.object({ value: z.json() }).parse(await runCommand(current, 'settings.get', { key })).value;
    return { value: await read('coordinator.member'), model: await read('coordinator.model') };
  });
  const [hireError, setHireError] = useState<string | null>(null);
  // The role whose hire was refused for its model: it gets a choice of the models that fit.
  const [picking, setPicking] = useState<string | null>(null);
  const [defining, setDefining] = useState(false);
  const [editing, setEditing] = useState<RoleDetails | null>(null);
  // The hired member whose name, model and budget are open for changing.
  const [changing, setChanging] = useState<string | null>(null);
  const hiredRoles = new Set((crew.data?.crew ?? []).map((member) => member.roleId));
  const model = coordinator.data?.model;

  return (
    <>
      <div className="view-head">
        <h1>{t('Crew')}</h1>
        <span className="muted">
          {t('The agents you have hired, and the roles you can hire for.')}
        </span>
      </div>
      {crew.error !== null && <p className="error">{crew.error}</p>}
      <div className="grid">
        {(crew.data?.crew ?? []).map((member) => (
          <article key={member.id} className="card stack">
            <div className="row">
              <span className="monogram" aria-hidden="true">
                {member.name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <h3>{tx(member.name)}</h3>
                <span className="mono muted">{member.model}</span>
              </div>
            </div>
            <div className="row spread muted">
              <span>{t('Up to {cost} per run', { cost: formatUsd(member.budgetUsdPerRun) })}</span>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={member.webSearch}
                  aria-label={t('{name} can search the web', { name: tx(member.name) })}
                  onChange={() => {
                    runCommand(imp, 'crew.update', {
                      id: member.id,
                      webSearch: !member.webSearch,
                    }).catch((error: unknown) => {
                      console.error(messageOf(error));
                    });
                  }}
                />
                {t('Web search')}
              </label>
              <button
                className="button quiet"
                aria-expanded={changing === member.id}
                aria-label={t('Change {name}', { name: tx(member.name) })}
                onClick={() => {
                  setChanging(changing === member.id ? null : member.id);
                }}
              >
                <PencilSimpleIcon aria-hidden="true" /> {t('Change')}
              </button>
              {member.id !== coordinator.data?.value &&
                member.roleId !== GLOBAL_COORDINATOR_ROLE && (
                  <button
                    className="button quiet"
                    aria-label={t('Dismiss {name}', { name: tx(member.name) })}
                    onClick={() => {
                      runCommand(imp, 'crew.dismiss', { id: member.id }).catch((error: unknown) => {
                        console.error(messageOf(error));
                      });
                    }}
                  >
                    <TrashIcon aria-hidden="true" /> {t('Dismiss')}
                  </button>
                )}
            </div>
            {changing === member.id && (
              <MemberForm
                member={member}
                coordinator={member.id === coordinator.data?.value}
                onDone={() => {
                  setChanging(null);
                }}
              />
            )}
          </article>
        ))}
      </div>
      <ProjectNeeds />
      <section className="stack" aria-labelledby="roles-heading">
        <div className="row spread wrap">
          <h2 id="roles-heading">{t('Roles')}</h2>
          {!defining && (
            <button
              className="button"
              onClick={() => {
                setDefining(true);
              }}
            >
              <PlusIcon aria-hidden="true" /> {t('New role')}
            </button>
          )}
        </div>
        <p className="muted">
          {t(
            'Hiring here uses the coordinator’s model. Change a member’s name, model or budget with Change on its card. You can define roles of your own, and so can the coordinator.',
          )}
        </p>
        {hireError !== null && (
          <p className="error" role="alert">
            {hireError}
          </p>
        )}
        {defining && (
          <RoleForm
            onDone={() => {
              setDefining(false);
            }}
          />
        )}
        {editing !== null && (
          <RoleForm
            key={editing.id}
            initial={editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        <div className="grid">
          {(roles.data?.roles ?? []).map((role) => (
            <article key={role.id} className="card stack">
              <div className="row spread">
                <h3>{tx(role.name)}</h3>
                {role.custom && <span className="tag neutral">{t('Custom')}</span>}
              </div>
              <p className="muted">{tx(role.summary)}</p>
              <span className="muted">
                {role.modelInput.includes('image')
                  ? t('Needs a model that sees pictures')
                  : t('A text-only model is enough')}
              </span>
              <div className="row">
                {hiredRoles.has(role.id) ? (
                  <span className="tag">{t('On the crew')}</span>
                ) : (
                  <button
                    className="button"
                    disabled={typeof model !== 'string'}
                    onClick={() => {
                      setHireError(null);
                      setPicking(null);
                      runCommand(imp, 'crew.hire', { roleId: role.id, model }).catch(
                        (error: unknown) => {
                          setHireError(messageOf(error));
                          // Refused for its model: offer the ones that fit the role.
                          if (role.modelInput.length > 0) setPicking(role.id);
                        },
                      );
                    }}
                  >
                    <UserPlusIcon aria-hidden="true" /> {t('Hire {name}', { name: tx(role.name) })}
                  </button>
                )}
                {role.extra === true && !hiredRoles.has(role.id) && (
                  <button
                    className="button quiet"
                    onClick={() => {
                      runCommand(imp, 'crew.role.remove', { id: role.id }).catch(
                        (error: unknown) => {
                          setHireError(messageOf(error));
                        },
                      );
                    }}
                  >
                    {t('Put away')}
                  </button>
                )}
                {role.custom && (
                  <button
                    className="button quiet"
                    onClick={() => {
                      setHireError(null);
                      runCommand(imp, 'crew.role.get', { id: role.id }).then(
                        (details) => {
                          setEditing(RoleDetails.parse(details));
                        },
                        (error: unknown) => {
                          setHireError(messageOf(error));
                        },
                      );
                    }}
                  >
                    <PencilSimpleIcon aria-hidden="true" /> {t('Change')}
                  </button>
                )}
                {role.custom && !hiredRoles.has(role.id) && (
                  <ConfirmButton
                    label={t('Delete role')}
                    question={t('Delete this role for good?')}
                    onConfirm={() => {
                      runCommand(imp, 'crew.role.delete', { id: role.id }).catch(
                        (error: unknown) => {
                          setHireError(messageOf(error));
                        },
                      );
                    }}
                  >
                    <TrashIcon aria-hidden="true" />
                  </ConfirmButton>
                )}
              </div>
              {picking === role.id && !hiredRoles.has(role.id) && (
                <ModelChoice
                  id={`hire-model-${role.id}`}
                  label={t('Hire with a model that fits')}
                  empty={t('Choose a model')}
                  output="text"
                  tools
                  role={role.id}
                  value={null}
                  onChoose={async (chosen) => {
                    setHireError(null);
                    try {
                      await runCommand(imp, 'crew.hire', { roleId: role.id, model: chosen });
                      setPicking(null);
                    } catch (error: unknown) {
                      setHireError(messageOf(error));
                    }
                  }}
                />
              )}
            </article>
          ))}
        </div>
        {(roles.data?.extras.length ?? 0) > 0 && (
          <section className="stack" aria-labelledby="extra-roles-heading">
            <h3 id="extra-roles-heading">{t('More roles')}</h3>
            <p className="muted">
              {t(
                'Built-in roles that are not part of the usual crew. Add one to hire it here; the coordinator can add them too.',
              )}
            </p>
            <div className="grid">
              {(roles.data?.extras ?? []).map((role) => (
                <article key={role.id} className="card stack">
                  <h3>{tx(role.name)}</h3>
                  <p className="muted">{tx(role.summary)}</p>
                  <div className="row">
                    <button
                      className="button"
                      onClick={() => {
                        setHireError(null);
                        runCommand(imp, 'crew.role.add', { id: role.id }).catch(
                          (error: unknown) => {
                            setHireError(messageOf(error));
                          },
                        );
                      }}
                    >
                      <PlusIcon aria-hidden="true" /> {t('Add {name}', { name: tx(role.name) })}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </section>
    </>
  );
}

/** A custom role as crew.role.get returns it, to change it in the form. */
const RoleDetails = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  brief: z.string(),
  commands: z.array(z.string()),
  writes: z.array(z.string()),
  effects: z.array(z.string()),
  webSearch: z.boolean(),
  sees: z.array(z.string()).nullable(),
  needs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      providedBy: z.string().nullable(),
    }),
  ),
});
type RoleDetails = z.infer<typeof RoleDetails>;

/** The needs any role has, which a custom role can share, from crew.needs. */
const KnownNeeds = z.object({
  roles: z.array(
    z.object({
      needs: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          providedBy: z.string().nullable(),
        }),
      ),
    }),
  ),
});

/** A checkbox in a list of choices. */
const NeedsInProject = z.object({
  projectId: z.string().nullable(),
  roles: z.array(
    z.object({
      needs: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          state: z.enum(['met', 'missing', 'waived', 'unchecked']),
          waivedBecause: z.string().nullable(),
        }),
      ),
    }),
  ),
});
type ProjectNeed = z.infer<typeof NeedsInProject>['roles'][number]['needs'][number];

function needStateLabel(state: ProjectNeed['state']): string {
  switch (state) {
    case 'met':
      return t('There');
    case 'missing':
      return t('Missing');
    case 'waived':
      return t('Goes without');
    case 'unchecked':
      return t('Not checked');
  }
}

/**
 * What the roles need before they work, and which of it the open project goes
 * without (a film with no characters needs no cast), as crew.needs.waive says.
 */
function ProjectNeeds(): ReactElement | null {
  const imp = useImp();
  const open = useLive(['settings/project.current'], async (current) => {
    const value = z
      .object({ value: z.json() })
      .parse(await runCommand(current, 'settings.get', { key: 'project.current' })).value;
    return typeof value === 'string' ? value : null;
  });
  const projectId = open.data ?? null;
  const needs = useLive(
    ['roles/', 'roles-added/', ...(projectId === null ? [] : [`projects/${projectId}/`])],
    async (current) => {
      const listed = NeedsInProject.parse(await runCommand(current, 'crew.needs', {}));
      const byId = new Map<string, ProjectNeed>();
      for (const need of listed.roles.flatMap((role) => role.needs)) {
        if (!byId.has(need.id)) byId.set(need.id, need);
      }
      return { projectId: listed.projectId, needs: [...byId.values()] };
    },
  );
  const [error, setError] = useState<string | null>(null);
  if (needs.data === undefined || needs.data.projectId === null || needs.data.needs.length === 0)
    return null;
  return (
    <section className="stack" aria-labelledby="needs-heading">
      <h2 id="needs-heading">{t('What the crew needs in this project')}</h2>
      <p className="muted">
        {t(
          'Roles wait for these before they work. Tick “Goes without” for what this project does not have, such as a cast for a film with no characters.',
        )}
      </p>
      <ul className="needs-list">
        {needs.data.needs.map((need) => (
          <li key={need.id} className="row spread wrap">
            <span>
              {tx(need.name)} <span className="tag neutral">{needStateLabel(need.state)}</span>
              {need.waivedBecause !== null && need.waivedBecause !== '' && (
                <span className="muted"> · {need.waivedBecause}</span>
              )}
            </span>
            <label className="choice">
              <input
                type="checkbox"
                checked={need.state === 'waived'}
                onChange={(event) => {
                  setError(null);
                  runCommand(imp, 'crew.needs.waive', {
                    need: need.id,
                    waived: event.target.checked,
                    reason: event.target.checked ? t('Set in the Crew view') : '',
                  }).catch((cause: unknown) => {
                    setError(messageOf(cause));
                  });
                }}
              />
              {t('Goes without')}
            </label>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Changes a hired member's name, model and budget per run, as crew.update does for agents. */
function MemberForm({
  member,
  coordinator,
  onDone,
}: {
  member: z.infer<typeof CrewMember>;
  /** The coordinator's model is the agents' model setting too, so both change together. */
  coordinator: boolean;
  onDone: () => void;
}): ReactElement {
  const imp = useImp();
  const nameId = useId();
  const [name, setName] = useState(member.name);
  const [error, setError] = useState<string | null>(null);
  const run = (input: Record<string, unknown>): void => {
    setError(null);
    runCommand(imp, 'crew.update', { id: member.id, ...input }).catch((cause: unknown) => {
      setError(messageOf(cause));
    });
  };
  return (
    <form
      className="stack member-form"
      aria-label={t('Change {name}', { name: tx(member.name) })}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed !== '' && trimmed !== member.name) run({ name: trimmed });
        onDone();
      }}
    >
      <div className="field">
        <label htmlFor={nameId}>{t('Name')}</label>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={60}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onBlur={() => {
            const trimmed = name.trim();
            if (trimmed !== '' && trimmed !== member.name) run({ name: trimmed });
          }}
        />
      </div>
      <ModelChoice
        id={`member-model-${member.id}`}
        label={t('Model')}
        empty={t('Choose a model')}
        output="text"
        tools
        role={member.roleId}
        value={member.model}
        onChoose={async (model) => {
          setError(null);
          try {
            if (coordinator) {
              await chooseModel(
                (id, input) => runCommand(imp, id, input),
                AGENTS_MODEL_SETTING,
                model,
              );
            } else {
              await runCommand(imp, 'crew.update', { id: member.id, model });
            }
          } catch (cause: unknown) {
            setError(messageOf(cause));
          }
        }}
      />
      <NumberField
        label={t('Most per run (US$)')}
        value={member.budgetUsdPerRun}
        step={0.1}
        min={0.01}
        max={100}
        onCommit={(budgetUsdPerRun) => {
          run({ budgetUsdPerRun });
        }}
      />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="button">{t('Done')}</button>
      </div>
    </form>
  );
}

function Choice({
  checked,
  disabled = false,
  onToggle,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: ReactElement | string;
}): ReactElement {
  return (
    <label className="choice">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      {children}
    </label>
  );
}

/**
 * Defines a custom role, or changes one. Everything a role's scope holds is
 * set here, as the coordinator sets it with crew.role.create: what it reads,
 * what it may change (only its own area), what it must see (which decides
 * the models that fit), web search, spending and deleting, and what it needs
 * before it can start.
 */
function RoleForm({
  initial,
  onDone,
}: {
  initial?: RoleDetails;
  onDone: () => void;
}): ReactElement {
  const imp = useImp();
  const groups = [
    ...new Set(imp.commands.map((command) => `${command.id.split('.')[0] ?? command.id}.`)),
  ].sort();
  // A role an agent defined may name single commands; they stay choices of their own.
  const options = [
    ...new Set([...groups, ...(initial?.commands ?? []), ...(initial?.writes ?? [])]),
  ];
  const [name, setName] = useState(initial?.name ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [brief, setBrief] = useState(initial?.brief ?? '');
  const [reads, setReads] = useState<readonly string[]>(initial?.commands ?? []);
  const [changes, setChanges] = useState<readonly string[]>(initial?.writes ?? []);
  const [sees, setSees] = useState<readonly string[]>(initial?.sees ?? []);
  const [needs, setNeeds] = useState<RoleDetails['needs']>(initial?.needs ?? []);
  const [spend, setSpend] = useState(initial?.effects.includes('spend') ?? false);
  const [destroy, setDestroy] = useState(initial?.effects.includes('destructive') ?? false);
  const [webSearch, setWebSearch] = useState(initial?.webSearch ?? false);
  const [error, setError] = useState<string | null>(null);
  const known = useLive(['roles/'], async (current) => {
    const listed = KnownNeeds.parse(await runCommand(current, 'crew.needs', {}));
    const byId = new Map<string, RoleDetails['needs'][number]>();
    for (const need of listed.roles.flatMap((role) => role.needs)) {
      if (!byId.has(need.id)) {
        byId.set(need.id, {
          id: need.id,
          name: need.name,
          description: need.description,
          providedBy: need.providedBy,
        });
      }
    }
    return [...byId.values()];
  });
  const needOptions = [
    ...needs,
    ...(known.data ?? []).filter((need) => needs.every((chosen) => chosen.id !== need.id)),
  ];

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const fields = {
      name: name.trim(),
      summary: summary.trim(),
      brief: brief.trim(),
      commands: [...new Set([...reads, ...changes])],
      writes: [...changes],
      sees: [...sees],
      needs: needs.map(({ providedBy, ...need }) => ({
        ...need,
        ...(providedBy === null ? {} : { providedBy }),
      })),
      effects: [
        'read',
        ...(changes.length > 0 ? ['write'] : []),
        ...(spend ? ['spend'] : []),
        ...(destroy ? ['destructive'] : []),
      ],
      webSearch,
    };
    runCommand(
      imp,
      initial === undefined ? 'crew.role.create' : 'crew.role.update',
      initial === undefined ? fields : { id: initial.id, ...fields },
    ).then(onDone, (reason: unknown) => {
      setError(messageOf(reason));
    });
  };
  const toggle = (
    list: readonly string[],
    set: (next: readonly string[]) => void,
    item: string,
  ): void => {
    set(list.includes(item) ? list.filter((other) => other !== item) : [...list, item]);
  };
  const SEEN: readonly (readonly [string, string])[] = [
    ['image', t('pictures')],
    ['audio', t('sound')],
    ['video', t('video')],
  ];
  const plain = (prefix: string): string => (prefix.endsWith('.') ? prefix.slice(0, -1) : prefix);

  return (
    <form
      className="card stack page"
      onSubmit={submit}
      aria-label={initial === undefined ? t('New role') : t('Change role')}
    >
      <div className="field">
        <label htmlFor="role-name">{t('Name')}</label>
        <input
          id="role-name"
          className="input"
          value={name}
          placeholder={t('Dialogue Polisher')}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="role-summary">{t('In one line')}</label>
        <input
          id="role-summary"
          className="input"
          value={summary}
          placeholder={t('Tightens dialogue without changing what is said.')}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="role-brief">{t('Instructions')}</label>
        <textarea
          id="role-brief"
          className="input"
          rows={5}
          value={brief}
          placeholder={t('What this agent does, how it works and what it must respect.')}
          onChange={(event) => {
            setBrief(event.target.value);
          }}
        />
      </div>
      <fieldset className="choices">
        <legend>{t('May read')}</legend>
        {options.map((option) => (
          <Choice
            key={option}
            checked={reads.includes(option) || changes.includes(option)}
            disabled={changes.includes(option)}
            onToggle={() => {
              toggle(reads, setReads, option);
            }}
          >
            {plain(option)}
          </Choice>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>{t('May change (only its own area)')}</legend>
        {options.map((option) => (
          <Choice
            key={option}
            checked={changes.includes(option)}
            onToggle={() => {
              toggle(changes, setChanges, option);
            }}
          >
            {plain(option)}
          </Choice>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>{t('Must see (decides which models fit)')}</legend>
        {SEEN.map(([kind, label]) => (
          <Choice
            key={kind}
            checked={sees.includes(kind)}
            onToggle={() => {
              toggle(sees, setSees, kind);
            }}
          >
            {label}
          </Choice>
        ))}
        {sees.length === 0 && <span className="muted">{t('A text-only model is enough')}</span>}
      </fieldset>
      <fieldset className="choices">
        <legend>{t('Needs before it starts')}</legend>
        {needOptions.length === 0 && <span className="muted">{t('Nothing')}</span>}
        {needOptions.map((need) => (
          <Choice
            key={need.id}
            checked={needs.some((chosen) => chosen.id === need.id)}
            onToggle={() => {
              setNeeds(
                needs.some((chosen) => chosen.id === need.id)
                  ? needs.filter((chosen) => chosen.id !== need.id)
                  : [...needs, need],
              );
            }}
          >
            {tx(need.name)}
          </Choice>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>{t('It may also')}</legend>
        <Choice
          checked={webSearch}
          onToggle={() => {
            setWebSearch(!webSearch);
          }}
        >
          {t('search the web')}
        </Choice>
        <Choice
          checked={spend}
          onToggle={() => {
            setSpend(!spend);
          }}
        >
          {t('ask to spend money')}
        </Choice>
        <Choice
          checked={destroy}
          onToggle={() => {
            setDestroy(!destroy);
          }}
        >
          {t('ask to delete things')}
        </Choice>
      </fieldset>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          className="button primary"
          disabled={
            name.trim() === '' || brief.trim() === '' || reads.length + changes.length === 0
          }
        >
          {initial === undefined ? t('Create the role') : t('Save the role')}
        </button>
        <button type="button" className="button quiet" onClick={onDone}>
          {t('Cancel')}
        </button>
      </div>
    </form>
  );
}

/** A number or text setting, stored when the field is left. */
function PreferenceInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | string;
  onCommit: (value: number | string) => void;
}): ReactElement {
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? String(value);
  const numeric = typeof value === 'number';
  return (
    <input
      className="input"
      aria-label={label}
      type={numeric ? 'number' : 'text'}
      value={text}
      onChange={(event) => {
        setTyped(event.target.value);
      }}
      onBlur={() => {
        setTyped(null);
        if (numeric) {
          const next = Number(text);
          if (text.trim() !== '' && Number.isFinite(next) && next !== value) onCommit(next);
        } else if (text !== value) {
          onCommit(text);
        }
      }}
    />
  );
}

/** Whether agents' changes to the cut wait as a draft for the person (the default) or go in directly. */
function DraftsSwitch(): ReactElement {
  const imp = useImp();
  const stored = useLive(
    ['settings/edit.agent-drafts'],
    async (current) =>
      z
        .object({ value: z.json() })
        .parse(await runCommand(current, 'settings.get', { key: 'edit.agent-drafts' })).value,
  );
  const [error, setError] = useState<string | null>(null);
  const drafts = stored.data !== false;
  return (
    <div className="stack">
      <label className="choice">
        <input
          type="checkbox"
          checked={drafts}
          disabled={stored.data === undefined}
          onChange={() => {
            setError(null);
            runCommand(imp, 'settings.set', { key: 'edit.agent-drafts', value: !drafts }).catch(
              (cause: unknown) => {
                setError(messageOf(cause));
              },
            );
          }}
        />
        {t('Agents’ changes to the cut wait as a draft for you to keep or discard')}
      </label>
      <p className="muted small">
        {drafts
          ? t('Switch this off to let agents change the cut directly.')
          : t('Agents change the cut directly, without a draft.')}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function settingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? t('On') : t('Off');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Every model Imp makes things with, and the mix they come from, each changed right here. */
function SettingsModels(): ReactElement {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  const agents = useModelSetting(AGENTS_MODEL_SETTING, 'text', { tools: true });
  const video = useModelSetting(VIDEO_MODEL_SETTING, 'video');
  const speech = useModelSetting(SPEECH_MODEL_SETTING, 'speech');
  const images = useModelSetting(IMAGE_MODEL_SETTING, 'image');
  const effects = useModelSetting(EFFECT_MODEL_SETTING, 'speech');
  const music = useModelSetting(MUSIC_MODEL_SETTING, 'audio');
  const transcripts = useModelSetting(TRANSCRIPTION_MODEL_SETTING, 'transcription');
  const act: Act = async (id, input) => {
    setError(null);
    try {
      return await runCommand(imp, id, input);
    } catch (reason) {
      setError(messageOf(reason));
      return undefined;
    }
  };
  return (
    <section className="card stack settings-models" aria-labelledby="models-heading">
      <h3 id="models-heading">{t('Models')}</h3>
      <p className="muted">
        {t(
          'Which model makes each kind of thing. A change counts at once, on every stage. Switch the whole set with a mix, or change one model and save the set as a mix.',
        )}
      </p>
      <ModelPanel
        act={act}
        models={[
          {
            id: 'settings-agents-model',
            label: t('Agents'),
            empty: t('Choose a model for the agents'),
            setting: AGENTS_MODEL_SETTING,
            choice: agents,
          },
          {
            id: 'settings-video-model',
            label: t('Video'),
            empty: t('Choose a model to make clips'),
            setting: VIDEO_MODEL_SETTING,
            choice: video,
          },
          {
            id: 'settings-voice-model',
            label: t('Voice'),
            empty: t('Choose a model to record voices'),
            setting: SPEECH_MODEL_SETTING,
            choice: speech,
          },
          {
            id: 'settings-image-model',
            label: t('Image'),
            empty: t('Choose a model to draw pictures'),
            setting: IMAGE_MODEL_SETTING,
            choice: images,
          },
          {
            id: 'settings-effects-model',
            label: t('Sound effects'),
            empty: t('Choose a model to make effects'),
            setting: EFFECT_MODEL_SETTING,
            choice: effects,
          },
          {
            id: 'settings-music-model',
            label: t('Music'),
            empty: t('Choose a model to make music'),
            setting: MUSIC_MODEL_SETTING,
            choice: music,
          },
          {
            id: 'settings-transcript-model',
            label: t('Transcript'),
            empty: t('Choose a model to write transcripts'),
            setting: TRANSCRIPTION_MODEL_SETTING,
            choice: transcripts,
          },
        ]}
      />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SettingsView({ onForgetKey }: { onForgetKey: () => void }): ReactElement {
  const [serverError, setServerError] = useState<string | null>(null);
  const settings = useLive(['settings/'], async (current) =>
    SettingList.parse(await runCommand(current, 'settings.list', {})),
  );
  const imp = useImp();
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  // The models have their own section above, where they can be changed.
  const shown = (settings.data?.settings ?? [])
    .filter((setting) => !INTERNAL_SETTINGS.has(setting.key) && !MODEL_SETTINGS.has(setting.key))
    .sort((a, b) => settingLabel(a.key).localeCompare(settingLabel(b.key)));
  return (
    <>
      <div className="view-head">
        <h1>{t('Settings')}</h1>
        <span className="muted">
          {t(
            'Everything here can also be changed by the coordinator, or from the command palette.',
          )}
        </span>
      </div>
      {settings.error !== null && <p className="error">{settings.error}</p>}
      <section className="card stack" aria-labelledby="language-heading">
        <h3 id="language-heading">{t('Language')}</h3>
        <p className="muted">
          {t(
            'The language of Imp’s buttons, tips, guide and What’s new. Agents answer you in it too. Your films keep the language they are written in.',
          )}
        </p>
        <LanguagePicker />
      </section>
      <SettingsModels />
      <section className="card stack" aria-labelledby="settings-heading">
        <h3 id="settings-heading">{t('Preferences')}</h3>
        <dl className="settings-list">
          {shown.map((setting) => (
            <div key={setting.key} className="settings-row" title={setting.key}>
              <dt>{settingLabel(setting.key)}</dt>
              <dd className={typeof setting.value === 'string' ? 'mono' : undefined}>
                {typeof setting.value === 'boolean' ? (
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={setting.value}
                      aria-label={settingLabel(setting.key)}
                      onChange={() => {
                        runCommand(imp, 'settings.set', {
                          key: setting.key,
                          value: !setting.value,
                        }).catch((error: unknown) => {
                          setPreferenceError(messageOf(error));
                        });
                      }}
                    />
                    {settingValue(setting.value)}
                  </label>
                ) : typeof setting.value === 'number' || typeof setting.value === 'string' ? (
                  <PreferenceInput
                    label={settingLabel(setting.key)}
                    value={setting.value}
                    onCommit={(value) => {
                      setPreferenceError(null);
                      runCommand(imp, 'settings.set', { key: setting.key, value }).catch(
                        (error: unknown) => {
                          setPreferenceError(messageOf(error));
                        },
                      );
                    }}
                  />
                ) : (
                  settingValue(setting.value)
                )}
              </dd>
            </div>
          ))}
        </dl>
        {preferenceError !== null && (
          <p className="error" role="alert">
            {preferenceError}
          </p>
        )}
        {settings.data !== undefined && shown.length === 0 && (
          <p className="muted">{t('Nothing is set yet.')}</p>
        )}
      </section>
      <section className="card stack" aria-labelledby="always-heading">
        <h3 id="always-heading">{t('What agents do without asking')}</h3>
        <DraftsSwitch />
        <AllowanceFields />
        <AlwaysAllowed />
      </section>
      <section className="card stack" aria-labelledby="help-heading">
        <h3 id="help-heading">{t('Help')}</h3>
        <TipsSwitch />
        <div className="row">
          <button
            className="button"
            onClick={() => {
              openHelp('getting-started');
            }}
          >
            {t('Open the guide')}
          </button>
        </div>
      </section>
      <section className="card stack" aria-labelledby="backup-heading">
        <h3 id="backup-heading">{t('Save all and Load all')}</h3>
        <BackupPanel />
      </section>
      <section className="card stack" aria-labelledby="key-heading">
        <h3 id="key-heading">{t('OpenRouter key')}</h3>
        <p className="muted">
          {servedByLocalServer()
            ? t(
                'Imp on this computer keeps the key in its own file beside your projects, readable only by your user account. The browser never holds it, and no command or agent can read it.',
              )
            : t(
                'The key is kept encrypted in this browser, outside the data that commands and agents can read. The browser holds the encryption key in a form no page script can export.',
              )}
        </p>
        <div className="row">
          <button className="button" onClick={onForgetKey}>
            {servedByLocalServer()
              ? t('Remove the key from this computer')
              : t('Remove the key from this browser')}
          </button>
        </div>
      </section>
      <section className="card stack" aria-labelledby="host-heading">
        <h3 id="host-heading">{t('Where Imp runs')}</h3>
        {servedByLocalServer() ? (
          <>
            <p className="muted">
              {t(
                'Imp runs on this computer. Your projects and media are files in its data folder, and every browser window you open here shows the same work.',
              )}
            </p>
            <FfmpegOffer />
          </>
        ) : (
          <>
            <p className="muted">
              {t(
                'Imp runs inside this browser, and your projects are kept in the browser’s own storage. You can also run it on your computer: your work is then kept as files in a folder of yours, with room for large media. It needs Node.js 22 or newer.',
              )}
            </p>
            <div className="row">
              <button
                className="button"
                onClick={() => {
                  void saveFileAs(
                    {
                      suggestedName: 'imp-server.zip',
                      mediaType: 'application/zip',
                      description: t('Imp for your computer'),
                    },
                    async () => {
                      const response = await fetch('./imp-server.zip');
                      if (!response.ok) throw new Error(t('The download is not available here.'));
                      return response.blob();
                    },
                  ).catch((reason: unknown) => {
                    setServerError(messageOf(reason));
                  });
                }}
              >
                <DownloadSimpleIcon aria-hidden="true" /> {t('Download Imp for your computer')}
              </button>
            </div>
            {serverError !== null && <p className="error">{serverError}</p>}
            <p className="muted">
              {t(
                'Unzip it, run {command} in the folder and open the address it prints. Work done in the browser does not move over by itself.',
              )
                .split('{command}')
                .flatMap((part, index) =>
                  index === 0
                    ? [part]
                    : [
                        <span key={index} className="mono">
                          node imp.mjs
                        </span>,
                        part,
                      ],
                )}
            </p>
            <p className="muted">
              {t(
                'The download is not signed. If your computer warns about it, confirm once: on a Mac in System Settings, Privacy & Security, Open Anyway; on Windows with More info, Run anyway.',
              )}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  openHelp('where-imp-runs');
                }}
              >
                {t('How to open it')}
              </button>
            </p>
          </>
        )}
      </section>
    </>
  );
}

/** One command in the activity strip: when, who, what, and how it went. */
function activityLine(entry: z.infer<typeof ActivityEntry>): string {
  return `${new Date(entry.at).toLocaleTimeString(currentLanguage())} · ${
    entry.actor.kind === 'user' ? t('you') : entry.actor.role
  } · ${entry.commandId} · ${entry.outcome}`;
}

/**
 * Every command that ran, newest first. It keeps to one line with the latest
 * command, so the stage keeps its room, and opens to the recent ones on a tap.
 */
export function ActivityStrip(): ReactElement {
  const activity = useLive(['activity/'], async (current) =>
    ActivityList.parse(await runCommand(current, 'activity.list', { limit: 30 })),
  );
  const [open, setOpen] = useState(false);
  const latest = activity.data?.entries ?? [];
  const [first] = latest;
  return (
    <footer className={`strip mono${open ? ' open' : ''}`} aria-label={t('Activity')}>
      {first === undefined ? (
        <span className="strip-line">
          {t('Nothing has happened yet. Every command will be listed here with who ran it.')}
        </span>
      ) : (
        <>
          <button
            type="button"
            className="strip-toggle"
            aria-expanded={open}
            aria-controls="activity-list"
            onClick={() => {
              setOpen(!open);
            }}
          >
            <span className="strip-line" data-outcome={open ? undefined : first.outcome}>
              {open ? t('Recent commands, newest first') : activityLine(first)}
            </span>
            <span className="strip-more">
              {open ? t('Hide') : t('Recent {count}', { count: String(latest.length) })}
              <CaretUpIcon aria-hidden="true" />
            </span>
          </button>
          {open && (
            <ol id="activity-list">
              {latest.map((entry) => (
                <li key={entry.id} data-outcome={entry.outcome}>
                  {activityLine(entry)}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </footer>
  );
}
