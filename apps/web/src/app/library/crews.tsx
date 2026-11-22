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
const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;

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
        `${saved.name}: hired ${plural(hired.length, 'agent')}${
          dismissed.length > 0 ? `, dismissed ${dismissed.join(', ')}` : ''
        }.`,
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
            Name
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
            aria-label="Notes"
            placeholder="What this crew is good for"
            rows={2}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
          <div className="row">
            <button type="submit" className="button small">
              Save
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
              Cancel
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
            aria-label={`Rename ${saved.name}`}
            title="Rename"
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilSimpleIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <ul className="crew-card-members" aria-label={`Who is on ${saved.name}`}>
        {saved.members.map((member, index) => (
          <li key={`${member.name}-${String(index)}`} title={member.model}>
            <span className="crew-card-name">{member.name}</span>
            <span className="muted">{shortModel(member.model)}</span>
          </li>
        ))}
      </ul>
      {asking ? (
        <div className="crew-card-confirm" role="group" aria-label="Replace the crew">
          <span className="small">
            Dismiss {replacing.join(', ')} and their conversations? The coordinator stays.
          </span>
          <div className="row">
            <button
              type="button"
              className="button small"
              onClick={() => {
                load(true);
              }}
            >
              Replace
            </button>
            <button
              type="button"
              className="button quiet small"
              onClick={() => {
                setAsking(false);
              }}
            >
              Cancel
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
            <UsersThreeIcon aria-hidden="true" /> Load
          </button>
          <button
            type="button"
            className="button quiet small"
            title="Hire these agents next to the current crew"
            onClick={() => {
              load(false);
            }}
          >
            <UserPlusIcon aria-hidden="true" /> Add to crew
          </button>
          <button
            type="button"
            className="button quiet small"
            title="Save the current crew under this name instead"
            aria-label={`Update ${saved.name} with the current crew`}
            onClick={() => {
              run('crew.saved.save', { id: saved.id }, () => {
                onStatus(`${saved.name} now holds the current crew.`);
              });
            }}
          >
            <ArrowClockwiseIcon aria-hidden="true" />
          </button>
          <ConfirmButton
            label=""
            ariaLabel={`Delete ${saved.name}`}
            question={`Delete “${saved.name}”? The current crew stays.`}
            onConfirm={() => {
              run('crew.saved.delete', { id: saved.id }, () => {
                onStatus(`Deleted ${saved.name}.`);
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
    .map((member) => member.name);
  const crews = saved.data?.crews ?? [];

  return (
    <div className="crew-shelf">
      <form
        className="crew-save"
        onSubmit={(event) => {
          event.preventDefault();
          runCommand(imp, 'crew.saved.save', { name: name.trim() }).then(
            () => {
              onStatus(`Saved the crew as ${name.trim()}.`);
              setName('');
            },
            (reason: unknown) => {
              onStatus(messageOf(reason), true);
            },
          );
        }}
      >
        <label htmlFor={nameId} className="eyebrow">
          Save the current crew
          {crew !== undefined && ` (${plural(crew.length, 'agent')})`}
        </label>
        <div className="row">
          <input
            id={nameId}
            className="input"
            placeholder="Name, for example Drama team"
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
            <FloppyDiskIcon aria-hidden="true" /> Save
          </button>
        </div>
      </form>
      {saved.error !== null && <p className="error small">{saved.error}</p>}
      {saved.data !== undefined && crews.length === 0 && (
        <div className="library-empty">
          <UsersThreeIcon aria-hidden="true" size={36} weight="light" />
          <p>
            {query === ''
              ? 'No saved crews yet. Save the crew you have now under a name, and load it again in any project, in place of the current crew or next to it.'
              : 'No saved crew matches.'}
          </p>
        </div>
      )}
      <ul className="crew-cards" aria-label="Saved crews">
        {crews.map((entry) => (
          <CrewCard key={entry.id} saved={entry} replacing={replacing} onStatus={onStatus} />
        ))}
      </ul>
    </div>
  );
}
