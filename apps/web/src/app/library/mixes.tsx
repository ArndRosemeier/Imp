import {
  ArrowClockwiseIcon,
  CheckIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useId, useState, type ReactElement } from 'react';
import { messageOf, runCommand, useImp } from '../context.js';
import { ConfirmButton } from '../Field.js';
import { useModelMixes, type ModelMixes } from '../model-bar.js';

type Mix = ModelMixes['mixes'][number];
type Slot = ModelMixes['slots'][number];

const shortModel = (model: string): string => model.replace(/^~/, '').split('/').pop() ?? model;

function MixCard({
  mix,
  slots,
  active,
  changed,
  onStatus,
}: {
  mix: Mix;
  slots: readonly Slot[];
  active: boolean;
  changed: boolean;
  onStatus: (status: string, error?: boolean) => void;
}): ReactElement {
  const imp = useImp();
  const nameId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(mix.name);
  const [notes, setNotes] = useState(mix.notes);

  const run = (command: string, input: Record<string, unknown>, done: () => void) => {
    runCommand(imp, command, input).then(done, (reason: unknown) => {
      onStatus(messageOf(reason), true);
    });
  };

  return (
    <li className={`crew-card mix-card${active ? ' active' : ''}`}>
      {editing ? (
        <form
          className="stack tight"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              'models.mix.save',
              { id: mix.id, name: name.trim(), notes, models: mix.models },
              () => {
                setEditing(false);
              },
            );
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
            placeholder="What this mix is for, such as cheap drafts"
            rows={2}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
          <div className="row">
            <button type="submit" className="button small" disabled={name.trim() === ''}>
              Save
            </button>
            <button
              type="button"
              className="button quiet small"
              onClick={() => {
                setEditing(false);
                setName(mix.name);
                setNotes(mix.notes);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="crew-card-head">
          <SlidersHorizontalIcon aria-hidden="true" size={22} weight="duotone" />
          <div className="stack tight">
            <h3>
              {mix.name}
              {active && (
                <span className="mix-card-badge">{changed ? 'in use, changed' : 'in use'}</span>
              )}
            </h3>
            {mix.notes !== '' && <p className="muted small">{mix.notes}</p>}
          </div>
          <button
            type="button"
            className="button quiet small"
            aria-label={`Rename ${mix.name}`}
            title="Rename"
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilSimpleIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <ul className="crew-card-members" aria-label={`Models in ${mix.name}`}>
        {slots
          .filter((slot) => mix.models[slot.setting] !== undefined)
          .map((slot) => {
            const model = mix.models[slot.setting] ?? '';
            return (
              <li key={slot.setting} title={model}>
                <span className="crew-card-name">{slot.label}</span>
                <span className="muted">{shortModel(model)}</span>
              </li>
            );
          })}
      </ul>
      <div className="row crew-card-actions">
        <button
          type="button"
          className="button small"
          disabled={active && !changed}
          aria-label={`Use ${mix.name}`}
          onClick={() => {
            run('models.mix.apply', { id: mix.id }, () => {
              onStatus(`Using ${mix.name}.`);
            });
          }}
        >
          <CheckIcon aria-hidden="true" /> {active && changed ? 'Use again' : 'Use'}
        </button>
        <button
          type="button"
          className="button quiet small"
          title="Save the models in use under this name instead"
          aria-label={`Update ${mix.name} with the models in use`}
          onClick={() => {
            run('models.mix.save', { id: mix.id }, () => {
              onStatus(`${mix.name} now holds the models in use.`);
            });
          }}
        >
          <ArrowClockwiseIcon aria-hidden="true" />
        </button>
        <ConfirmButton
          label=""
          ariaLabel={`Delete ${mix.name}`}
          question={`Delete “${mix.name}”? The models in use stay.`}
          onConfirm={() => {
            run('models.mix.delete', { id: mix.id }, () => {
              onStatus(`Deleted ${mix.name}.`);
            });
          }}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      </div>
    </li>
  );
}

/**
 * Model mixes: which model makes each kind of thing, kept under a name. Like
 * saved crews they belong to the workspace, so a mix works in every project.
 */
export function MixShelf({
  query,
  onStatus,
}: {
  query: string;
  onStatus: (status: string, error?: boolean) => void;
}): ReactElement {
  const imp = useImp();
  const nameId = useId();
  const [name, setName] = useState('');
  const live = useModelMixes();
  const data = live.data;
  const words = query.trim().toLowerCase();
  const mixes = (data?.mixes ?? []).filter(
    (mix) =>
      words === '' ||
      [mix.name, mix.notes, ...Object.values(mix.models)].some((text) =>
        text.toLowerCase().includes(words),
      ),
  );
  const chosen = data === undefined ? 0 : Object.keys(data.current).length;

  return (
    <div className="crew-shelf">
      <form
        className="crew-save"
        onSubmit={(event) => {
          event.preventDefault();
          runCommand(imp, 'models.mix.save', { name: name.trim() }).then(
            () => {
              onStatus(`Saved the models as ${name.trim()}.`);
              setName('');
            },
            (reason: unknown) => {
              onStatus(messageOf(reason), true);
            },
          );
        }}
      >
        <label htmlFor={nameId} className="eyebrow">
          Save the models in use
          {data !== undefined && ` (${String(chosen)} of ${String(data.slots.length)} chosen)`}
        </label>
        <div className="row">
          <input
            id={nameId}
            className="input"
            placeholder="Name, for example Cheap drafts"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button
            type="submit"
            className="button small"
            disabled={name.trim() === '' || chosen === 0}
          >
            <FloppyDiskIcon aria-hidden="true" /> Save
          </button>
        </div>
      </form>
      {live.error !== null && <p className="error small">{live.error}</p>}
      {data !== undefined && mixes.length === 0 && (
        <div className="library-empty">
          <SlidersHorizontalIcon aria-hidden="true" size={36} weight="light" />
          <p>
            {words === ''
              ? 'No model mixes yet. Save the models in use under a name, such as a cheap mix for drafts and a better one for the final cut, and switch between them here or from the models chip on any stage.'
              : 'No model mix matches.'}
          </p>
        </div>
      )}
      <ul className="crew-cards" aria-label="Model mixes">
        {mixes.map((mix) => (
          <MixCard
            key={mix.id}
            mix={mix}
            slots={data?.slots ?? []}
            active={mix.id === data?.active}
            changed={data?.changed === true}
            onStatus={onStatus}
          />
        ))}
      </ul>
    </div>
  );
}
