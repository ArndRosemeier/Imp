import { CrewMember } from '@imp/agents';
import { ActivityEntry } from '@imp/core';
import { TrashIcon, UserPlusIcon } from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';

const CrewList = z.object({ crew: z.array(CrewMember) });
const RoleList = z.object({
  roles: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })),
});
const ActivityList = z.object({ entries: z.array(ActivityEntry) });
const SettingList = z.object({ settings: z.array(z.object({ key: z.string(), value: z.json() })) });

export function CrewView(): ReactElement {
  const imp = useImp();
  const crew = useLive(['crew/'], async (current) =>
    CrewList.parse(await runCommand(current, 'crew.list', {})),
  );
  const roles = useLive([], async (current) =>
    RoleList.parse(await runCommand(current, 'crew.roles', {})),
  );
  const coordinator = useLive(['settings/'], async (current) => {
    const read = async (key: string): Promise<unknown> =>
      z.object({ value: z.json() }).parse(await runCommand(current, 'settings.get', { key })).value;
    return { value: await read('coordinator.member'), model: await read('coordinator.model') };
  });
  const [hireError, setHireError] = useState<string | null>(null);
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
        <h2 id="roles-heading">Roles</h2>
        <p className="muted">
          Hiring here uses the coordinator’s model. For another model or budget, ask the coordinator
          or run “Hire agent” from the command palette.
        </p>
        {hireError !== null && (
          <p className="error" role="alert">
            {hireError}
          </p>
        )}
        <div className="grid">
          {(roles.data?.roles ?? []).map((role) => (
            <article key={role.id} className="card stack">
              <h3>{role.name}</h3>
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
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

export function SettingsView({ onForgetKey }: { onForgetKey: () => void }): ReactElement {
  const settings = useLive(['settings/'], async (current) =>
    SettingList.parse(await runCommand(current, 'settings.list', {})),
  );
  return (
    <>
      <div className="view-head">
        <h1>Settings</h1>
        <span className="muted">
          Everything here can also be changed by the coordinator, or from the command palette.
        </span>
      </div>
      {settings.error !== null && <p className="error">{settings.error}</p>}
      <div className="card stack">
        {(settings.data?.settings ?? []).map((setting) => (
          <div key={setting.key} className="row spread">
            <span className="mono">{setting.key}</span>
            <span className="mono muted">{JSON.stringify(setting.value)}</span>
          </div>
        ))}
        {settings.data?.settings.length === 0 && <p className="muted">Nothing is set yet.</p>}
      </div>
      <section className="card stack" aria-labelledby="key-heading">
        <h3 id="key-heading">OpenRouter key</h3>
        <p className="muted">
          The key is kept in this browser, outside the data that commands and agents can read.
        </p>
        <div className="row">
          <button className="button" onClick={onForgetKey}>
            Remove the key from this browser
          </button>
        </div>
      </section>
    </>
  );
}

export function ActivityStrip(): ReactElement {
  const activity = useLive(['activity/'], async (current) =>
    ActivityList.parse(await runCommand(current, 'activity.list', { limit: 30 })),
  );
  const latest = activity.data?.entries ?? [];
  return (
    <footer className="strip mono" aria-label="Activity">
      {latest.length === 0 ? (
        <span>Nothing has happened yet. Every command will be listed here with who ran it.</span>
      ) : (
        <ol>
          {latest.map((entry) => (
            <li key={entry.id} data-outcome={entry.outcome}>
              {new Date(entry.at).toLocaleTimeString()} ·{' '}
              {entry.actor.kind === 'user' ? 'you' : entry.actor.role} · {entry.commandId} ·{' '}
              {entry.outcome}
            </li>
          ))}
        </ol>
      )}
    </footer>
  );
}
