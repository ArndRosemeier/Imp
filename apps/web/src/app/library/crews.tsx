import {
  ArrowClockwiseIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
  TrashIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useId, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from '../context.js';
import { ConfirmButton } from '../Field.js';
import { t, tn, tx } from '../../i18n/i18n.js';

const SavedCrews = z.object({
  crews: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      notes: z.string(),
      updatedAt: z.string(),
      members: z.array(z.object({ roleId: z.string(), name: z.string(), model: z.string() })),
    }),
  ),
});
type SavedCrew = z.infer<typeof SavedCrews>['crews'][number];

const Crew = z.object({
  crew: z.array(z.object({ id: z.string(), roleId: z.string(), name: z.string() })),
});
const Loaded = z.object({ hired: z.array(z.unknown()), dismissed: z.array(z.string()) });

/** How many saved crews there are, for the library's tab. */
export function useSavedCrewCount(): number | undefined {
  return useLive(['saved-crews/'], async (imp) =>
    SavedCrews.parse(await runCommand(imp, 'crew.saved.list', {})),
  ).data?.crews.length;
}

const shortModel = (model: string): string => model.replace(/^~/, '').split('/').pop() ?? model;
const agents = (count: number): string => tn(count, '{count} agent', '{count} agents');

function CrewCard({
  saved,
  replacing,
  onStatus,
}: {
  saved: SavedCrew;
  /** Who loading this crew would dismiss: everyone on the crew but the coordinator. */
  replacing: readonly string[];
  onStatus: (status: string, error?: boolean) => void;
}): ReactElement {
  const imp = useImp();
  const nameId = useId();
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(saved.name);
  const [notes, setNotes] = useState(saved.notes);

  const run = (
    command: string,
    input: Record<string, unknown>,
    done: (output: unknown) => void,
  ) => {
    runCommand(imp, command, input).then(done, (reason: unknown) => {
      onStatus(messageOf(reason), true);
    });
  };
  const load = (replace: boolean) => {
    setAsking(false);
    run('crew.saved.load', { id: saved.id, replace }, (output) => {
      const { hired, dismissed } = Loaded.parse(output);
      onStatus(
        dismissed.length > 0
          ? t('{name}: hired {agents}, dismissed {dismissed}.', {
              name: saved.name,
              agents: agents(hired.length),
              dismissed: dismissed.join(', '),
            })
          : t('{name}: hired {agents}.', { name: saved.name, agents: agents(hired.length) }),
      );
    });
  };

  return (
    <li className="crew-card">
      {editing ? (
        <form
          className="stack tight"
          onSubmit={(event) => {
            event.preventDefault();
            run('crew.saved.update', { id: saved.id, name, notes }, () => {
              setEditing(false);
            });
          }}
        >
          <label className="sr-only" htmlFor={nameId}>
            {t('Name')}
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <textarea
            className="input"
            aria-label={t('Notes')}
            placeholder={t('What this crew is good for')}
            rows={2}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
          <div className="row">
            <button type="submit" className="button small">
              {t('Save')}
            </button>
            <button
              type="button"
              className="button quiet small"
              onClick={() => {
                setEditing(false);
                setName(saved.name);
                setNotes(saved.notes);
              }}
            >
              {t('Cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="crew-card-head">
          <UsersThreeIcon aria-hidden="true" size={22} weight="duotone" />
          <div className="stack tight">
            <h3>{saved.name}</h3>
            {saved.notes !== '' && <p className="muted small">{saved.notes}</p>}
          </div>
          <button
            type="button"
            className="button quiet small"
            aria-label={t('Rename {name}', { name: saved.name })}
            title={t('Rename')}
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilSimpleIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <ul className="crew-card-members" aria-label={t('Who is on {name}', { name: saved.name })}>
        {saved.members.map((member, index) => (
          <li key={`${member.name}-${String(index)}`} title={member.model}>
            <span className="crew-card-name">{tx(member.name)}</span>
            <span className="muted">{shortModel(member.model)}</span>
          </li>
        ))}
      </ul>
      {asking ? (
        <div className="crew-card-confirm" role="group" aria-label={t('Replace the crew')}>
          <span className="small">
            {t('Dismiss {value} and their conversations? The coordinator stays.', {
              value: replacing.join(', '),
            })}
          </span>
          <div className="row">
            <button
              type="button"
              className="button small"
              onClick={() => {
                load(true);
              }}
            >
              {t('Replace')}
            </button>
            <button
              type="button"
              className="button quiet small"
              onClick={() => {
                setAsking(false);
              }}
            >
              {t('Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="row crew-card-actions">
          <button
            type="button"
            className="button small"
            onClick={() => {
              if (replacing.length === 0) load(true);
              else setAsking(true);
            }}
          >
            <UsersThreeIcon aria-hidden="true" /> {t('Load')}
          </button>
          <button
            type="button"
            className="button quiet small"
            title={t('Hire these agents next to the current crew')}
            onClick={() => {
              load(false);
            }}
          >
            <UserPlusIcon aria-hidden="true" /> {t('Add to crew')}
          </button>
          <button
            type="button"
            className="button quiet small"
            title={t('Save the current crew under this name instead')}
            aria-label={t('Update {name} with the current crew', { name: saved.name })}
            onClick={() => {
              run('crew.saved.save', { id: saved.id }, () => {
                onStatus(t('{name} now holds the current crew.', { name: saved.name }));
              });
            }}
          >
            <ArrowClockwiseIcon aria-hidden="true" />
          </button>
          <ConfirmButton
            label=""
            ariaLabel={t('Delete {name}', { name: saved.name })}
            question={t('Delete “{name}”? The current crew stays.', { name: saved.name })}
            onConfirm={() => {
              run('crew.saved.delete', { id: saved.id }, () => {
                onStatus(t('Deleted {name}.', { name: saved.name }));
              });
            }}
          >
            <TrashIcon aria-hidden="true" />
          </ConfirmButton>
        </div>
      )}
    </li>
  );
}

/**
 * Crews kept under a name. They belong to the workspace, so a crew saved in
 * one project can be loaded in any other.
 */
export function CrewShelf({
  query,
  onStatus,
}: {
  query: string;
  onStatus: (status: string, error?: boolean) => void;
}): ReactElement {
  const imp = useImp();
  const nameId = useId();
  const [name, setName] = useState('');
  const saved = useLive(['saved-crews/', `q:${query}`], async (current) =>
    SavedCrews.parse(await runCommand(current, 'crew.saved.list', { query })),
  );
  const crew = useLive(['crew/'], async (current) =>
    Crew.parse(await runCommand(current, 'crew.list', {})),
  ).data?.crew;
  const replacing = (crew ?? [])
    .filter((member) => member.roleId !== 'coordinator')
    .map((member) => tx(member.name))
    // By name: agents hired in the same millisecond have no other order.
    .sort((a, b) => a.localeCompare(b));
  const crews = saved.data?.crews ?? [];

  return (
    <div className="crew-shelf">
      <form
        className="crew-save"
        onSubmit={(event) => {
          event.preventDefault();
          runCommand(imp, 'crew.saved.save', { name: name.trim() }).then(
            () => {
              onStatus(t('Saved the crew as {value}.', { value: name.trim() }));
              setName('');
            },
            (reason: unknown) => {
              onStatus(messageOf(reason), true);
            },
          );
        }}
      >
        <label htmlFor={nameId} className="eyebrow">
          {t('Save the current crew')}
          {crew !== undefined && ` (${agents(crew.length)})`}
        </label>
        <div className="row">
          <input
            id={nameId}
            className="input"
            placeholder={t('Name, for example Drama team')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button
            type="submit"
            className="button small"
            disabled={name.trim() === '' || crew?.length === 0}
          >
            <FloppyDiskIcon aria-hidden="true" /> {t('Save')}
          </button>
        </div>
      </form>
      {saved.error !== null && <p className="error small">{saved.error}</p>}
      {saved.data !== undefined && crews.length === 0 && (
        <div className="library-empty">
          <UsersThreeIcon aria-hidden="true" size={36} weight="light" />
          <p>
            {query === ''
              ? t(
                  'No saved crews yet. Save the crew you have now under a name, and load it again in any project, in place of the current crew or next to it.',
                )
              : t('No saved crew matches.')}
          </p>
        </div>
      )}
      <ul className="crew-cards" aria-label={t('Saved crews')}>
        {crews.map((entry) => (
          <CrewCard key={entry.id} saved={entry} replacing={replacing} onStatus={onStatus} />
        ))}
      </ul>
    </div>
  );
}
