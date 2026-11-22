import { CrewMember } from '@imp/agents';
import { ActivityEntry } from '@imp/core';
import {
  CaretUpIcon,
  DownloadSimpleIcon,
  PlusIcon,
  TrashIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import { useState, type ReactElement, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { servedByLocalServer } from '../host/served.js';
import { ConfirmButton } from './Field.js';
import { useModelMixes } from './model-bar.js';
import { TipsSwitch } from './help/HelpPanel.js';
import { openHelp } from './help/help.js';
import { FfmpegOffer } from './FfmpegOffer.js';
import { BackupPanel } from './backup.js';
import { saveFileAs } from './save-file.js';
import { ACTIVE_MIX_KEY, INTERNAL_SETTINGS, settingLabel } from './settings-labels.js';

const CrewList = z.object({ crew: z.array(CrewMember) });
const RoleList = z.object({
  roles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      custom: z.boolean(),
      extra: z.boolean().optional(),
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
  const [defining, setDefining] = useState(false);
  const hiredRoles = new Set((crew.data?.crew ?? []).map((member) => member.roleId));
  const model = coordinator.data?.model;

  return (
    <>
      <div className="view-head">
        <h1>Crew</h1>
        <span className="muted">The agents you have hired, and the roles you can hire for.</span>
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
                <h3>{member.name}</h3>
                <span className="mono muted">{member.model}</span>
              </div>
            </div>
            <div className="row spread muted">
              <span>Up to ${member.budgetUsdPerRun.toFixed(2)} per run</span>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={member.webSearch}
                  aria-label={`${member.name} can search the web`}
                  onChange={() => {
                    runCommand(imp, 'crew.update', {
                      id: member.id,
                      webSearch: !member.webSearch,
                    }).catch((error: unknown) => {
                      console.error(messageOf(error));
                    });
                  }}
                />
                Web search
              </label>
              {member.id !== coordinator.data?.value && (
                <button
                  className="button quiet"
                  aria-label={`Dismiss ${member.name}`}
                  onClick={() => {
                    runCommand(imp, 'crew.dismiss', { id: member.id }).catch((error: unknown) => {
                      console.error(messageOf(error));
                    });
                  }}
                >
                  <TrashIcon aria-hidden="true" /> Dismiss
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <section className="stack" aria-labelledby="roles-heading">
        <div className="row spread wrap">
          <h2 id="roles-heading">Roles</h2>
          {!defining && (
            <button
              className="button"
              onClick={() => {
                setDefining(true);
              }}
            >
              <PlusIcon aria-hidden="true" /> New role
            </button>
          )}
        </div>
        <p className="muted">
          Hiring here uses the coordinator’s model. For another model or budget, ask the coordinator
          or run “Hire agent” from the command palette. You can define roles of your own, and so can
          the coordinator.
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
        <div className="grid">
          {(roles.data?.roles ?? []).map((role) => (
            <article key={role.id} className="card stack">
              <div className="row spread">
                <h3>{role.name}</h3>
                {role.custom && <span className="tag neutral">Custom</span>}
              </div>
              <p className="muted">{role.summary}</p>
              <div className="row">
                {hiredRoles.has(role.id) ? (
                  <span className="tag">On the crew</span>
                ) : (
                  <button
                    className="button"
                    disabled={typeof model !== 'string'}
                    onClick={() => {
                      setHireError(null);
                      runCommand(imp, 'crew.hire', { roleId: role.id, model }).catch(
                        (error: unknown) => {
                          setHireError(messageOf(error));
                        },
                      );
                    }}
                  >
                    <UserPlusIcon aria-hidden="true" /> Hire {role.name}
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
                    Put away
                  </button>
                )}
                {role.custom && !hiredRoles.has(role.id) && (
                  <ConfirmButton
                    label="Delete role"
                    question="Delete this role for good?"
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
            </article>
          ))}
        </div>
        {(roles.data?.extras.length ?? 0) > 0 && (
          <section className="stack" aria-labelledby="extra-roles-heading">
            <h3 id="extra-roles-heading">More roles</h3>
            <p className="muted">
              Built-in roles that are not part of the usual crew. Add one to hire it here; the
              coordinator can add them too.
            </p>
            <div className="grid">
              {(roles.data?.extras ?? []).map((role) => (
                <article key={role.id} className="card stack">
                  <h3>{role.name}</h3>
                  <p className="muted">{role.summary}</p>
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
                      <PlusIcon aria-hidden="true" /> Add {role.name}
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

/** Defines a custom role. What it may use is picked from the groups of commands that exist. */
function RoleForm({ onDone }: { onDone: () => void }): ReactElement {
  const imp = useImp();
  const groups = [
    ...new Set(imp.commands.map((command) => command.id.split('.')[0] ?? command.id)),
  ].sort();
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [brief, setBrief] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [change, setChange] = useState(true);
  const [spend, setSpend] = useState(false);
  const [destroy, setDestroy] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    runCommand(imp, 'crew.role.create', {
      name: name.trim(),
      summary: summary.trim(),
      brief: brief.trim(),
      commands: chosen.map((group) => `${group}.`),
      effects: [
        'read',
        ...(change ? ['write'] : []),
        ...(spend ? ['spend'] : []),
        ...(destroy ? ['destructive'] : []),
      ],
      webSearch,
    }).then(onDone, (reason: unknown) => {
      setError(messageOf(reason));
    });
  };
  const toggle = (group: string): void => {
    setChosen(
      chosen.includes(group) ? chosen.filter((item) => item !== group) : [...chosen, group],
    );
  };

  return (
    <form className="card stack page" onSubmit={submit} aria-label="New role">
      <div className="field">
        <label htmlFor="role-name">Name</label>
        <input
          id="role-name"
          className="input"
          value={name}
          placeholder="Dialogue Polisher"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="role-summary">In one line</label>
        <input
          id="role-summary"
          className="input"
          value={summary}
          placeholder="Tightens dialogue without changing what is said."
          onChange={(event) => {
            setSummary(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="role-brief">Instructions</label>
        <textarea
          id="role-brief"
          className="input"
          rows={5}
          value={brief}
          placeholder="What this agent does, how it works and what it must respect."
          onChange={(event) => {
            setBrief(event.target.value);
          }}
        />
      </div>
      <fieldset className="choices">
        <legend>May use</legend>
        {groups.map((group) => (
          <label key={group} className="choice">
            <input
              type="checkbox"
              checked={chosen.includes(group)}
              onChange={() => {
                toggle(group);
              }}
            />
            {group}
          </label>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>Beyond reading, may</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={change}
            onChange={() => {
              setChange(!change);
            }}
          />
          change things
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={spend}
            onChange={() => {
              setSpend(!spend);
            }}
          />
          ask to spend money
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={destroy}
            onChange={() => {
              setDestroy(!destroy);
            }}
          />
          ask to delete things
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={webSearch}
            onChange={() => {
              setWebSearch(!webSearch);
            }}
          />
          search the web
        </label>
      </fieldset>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          className="button primary"
          disabled={name.trim() === '' || brief.trim() === '' || chosen.length === 0}
        >
          Create the role
        </button>
        <button type="button" className="button quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function settingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function SettingsView({ onForgetKey }: { onForgetKey: () => void }): ReactElement {
  const [serverError, setServerError] = useState<string | null>(null);
  const settings = useLive(['settings/'], async (current) =>
    SettingList.parse(await runCommand(current, 'settings.list', {})),
  );
  const mixes = useModelMixes().data;
  const shown = (settings.data?.settings ?? [])
    .filter((setting) => !INTERNAL_SETTINGS.has(setting.key))
    .sort((a, b) => settingLabel(a.key).localeCompare(settingLabel(b.key)));
  return (
    <>
      <div className="view-head">
        <h1>Settings</h1>
        <span className="muted">
          Everything here can also be changed by the coordinator, or from the command palette.
        </span>
      </div>
      {settings.error !== null && <p className="error">{settings.error}</p>}
      <section className="card stack" aria-labelledby="settings-heading">
        <h3 id="settings-heading">Models and preferences</h3>
        <dl className="settings-list">
          {shown.map((setting) => (
            <div key={setting.key} className="settings-row" title={setting.key}>
              <dt>{settingLabel(setting.key)}</dt>
              <dd className={typeof setting.value === 'string' ? 'mono' : undefined}>
                {setting.key === ACTIVE_MIX_KEY
                  ? (mixes?.mixes.find((mix) => mix.id === setting.value)?.name ?? 'None')
                  : settingValue(setting.value)}
              </dd>
            </div>
          ))}
        </dl>
        {settings.data !== undefined && shown.length === 0 && (
          <p className="muted">Nothing is set yet.</p>
        )}
      </section>
      <section className="card stack" aria-labelledby="help-heading">
        <h3 id="help-heading">Help</h3>
        <TipsSwitch />
        <div className="row">
          <button
            className="button"
            onClick={() => {
              openHelp('getting-started');
            }}
          >
            Open the guide
          </button>
        </div>
      </section>
      <section className="card stack" aria-labelledby="backup-heading">
        <h3 id="backup-heading">Save all and Load all</h3>
        <BackupPanel />
      </section>
      <section className="card stack" aria-labelledby="key-heading">
        <h3 id="key-heading">OpenRouter key</h3>
        <p className="muted">
          {servedByLocalServer()
            ? 'Imp on this computer keeps the key in its own file beside your projects, readable only by your user account. The browser never holds it, and no command or agent can read it.'
            : 'The key is kept encrypted in this browser, outside the data that commands and agents can read. The browser holds the encryption key in a form no page script can export.'}
        </p>
        <div className="row">
          <button className="button" onClick={onForgetKey}>
            {servedByLocalServer()
              ? 'Remove the key from this computer'
              : 'Remove the key from this browser'}
          </button>
        </div>
      </section>
      <section className="card stack" aria-labelledby="host-heading">
        <h3 id="host-heading">Where Imp runs</h3>
        {servedByLocalServer() ? (
          <>
            <p className="muted">
              Imp runs on this computer. Your projects and media are files in its data folder, and
              every browser window you open here shows the same work.
            </p>
            <FfmpegOffer />
          </>
        ) : (
          <>
            <p className="muted">
              Imp runs inside this browser, and your projects are kept in the browser&rsquo;s own
              storage. You can also run it on your computer: your work is then kept as files in a
              folder of yours, with room for large media. It needs Node.js 22 or newer.
            </p>
            <div className="row">
              <button
                className="button"
                onClick={() => {
                  void saveFileAs(
                    {
                      suggestedName: 'imp-server.zip',
                      mediaType: 'application/zip',
                      description: 'Imp for your computer',
                    },
                    async () => {
                      const response = await fetch('./imp-server.zip');
                      if (!response.ok) throw new Error('The download is not available here.');
                      return response.blob();
                    },
                  ).catch((reason: unknown) => {
                    setServerError(messageOf(reason));
                  });
                }}
              >
                <DownloadSimpleIcon aria-hidden="true" /> Download Imp for your computer
              </button>
            </div>
            {serverError !== null && <p className="error">{serverError}</p>}
            <p className="muted">
              Unzip it, run <span className="mono">node imp.mjs</span> in the folder and open the
              address it prints. Work done in the browser does not move over by itself.
            </p>
            <p className="muted">
              The download is not signed. If your computer warns about it, confirm once: on a Mac in
              System Settings, Privacy &amp; Security, Open Anyway; on Windows with More info, Run
              anyway.{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  openHelp('where-imp-runs');
                }}
              >
                How to open it
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
  return `${new Date(entry.at).toLocaleTimeString()} · ${
    entry.actor.kind === 'user' ? 'you' : entry.actor.role
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
    <footer className={`strip mono${open ? ' open' : ''}`} aria-label="Activity">
      {first === undefined ? (
        <span className="strip-line">
          Nothing has happened yet. Every command will be listed here with who ran it.
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
              {open ? 'Recent commands, newest first' : activityLine(first)}
            </span>
            <span className="strip-more">
              {open ? 'Hide' : `Recent ${String(latest.length)}`}
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
