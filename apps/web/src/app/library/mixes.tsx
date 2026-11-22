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
import { t, tx } from '../../i18n/i18n.js';

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
            placeholder={t('What this mix is for, such as cheap drafts')}
            rows={2}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
          <div className="row">
            <button type="submit" className="button small" disabled={name.trim() === ''}>
              {t('Save')}
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
              {t('Cancel')}
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
                <span className="mix-card-badge">
                  {changed ? t('in use, changed') : t('in use')}
                </span>
              )}
            </h3>
            {mix.notes !== '' && <p className="muted small">{mix.notes}</p>}
          </div>
          <button
            type="button"
            className="button quiet small"
            aria-label={t('Rename {name}', { name: mix.name })}
            title={t('Rename')}
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilSimpleIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <ul className="crew-card-members" aria-label={t('Models in {name}', { name: mix.name })}>
        {slots
          .filter((slot) => mix.models[slot.setting] !== undefined)
          .map((slot) => {
            const model = mix.models[slot.setting] ?? '';
            return (
              <li key={slot.setting} title={model}>
                <span className="crew-card-name">{tx(slot.label)}</span>
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
          aria-label={t('Use {name}', { name: mix.name })}
          onClick={() => {
            run('models.mix.apply', { id: mix.id }, () => {
              onStatus(t('Using {name}.', { name: mix.name }));
            });
          }}
        >
          <CheckIcon aria-hidden="true" /> {active && changed ? t('Use again') : t('Use')}
        </button>
        <button
          type="button"
          className="button quiet small"
          title={t('Save the models in use under this name instead')}
          aria-label={t('Update {name} with the models in use', { name: mix.name })}
          onClick={() => {
            run('models.mix.save', { id: mix.id }, () => {
              onStatus(t('{name} now holds the models in use.', { name: mix.name }));
            });
          }}
        >
          <ArrowClockwiseIcon aria-hidden="true" />
        </button>
        <ConfirmButton
          label=""
          ariaLabel={t('Delete {name}', { name: mix.name })}
          question={t('Delete “{name}”? The models in use stay.', { name: mix.name })}
          onConfirm={() => {
            run('models.mix.delete', { id: mix.id }, () => {
              onStatus(t('Deleted {name}.', { name: mix.name }));
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
              onStatus(t('Saved the models as {value}.', { value: name.trim() }));
              setName('');
            },
            (reason: unknown) => {
              onStatus(messageOf(reason), true);
            },
          );
        }}
      >
        <label htmlFor={nameId} className="eyebrow">
          {t('Save the models in use')}
          {data !== undefined &&
            ` ${t('({chosen} of {total} chosen)', { chosen, total: data.slots.length })}`}
        </label>
        <div className="row">
          <input
            id={nameId}
            className="input"
            placeholder={t('Name, for example Cheap drafts')}
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
            <FloppyDiskIcon aria-hidden="true" /> {t('Save')}
          </button>
        </div>
      </form>
      {live.error !== null && <p className="error small">{live.error}</p>}
      {data !== undefined && mixes.length === 0 && (
        <div className="library-empty">
          <SlidersHorizontalIcon aria-hidden="true" size={36} weight="light" />
          <p>
            {words === ''
              ? t(
                  'No model mixes yet. Save the models in use under a name, such as a cheap mix for drafts and a better one for the final cut, and switch between them here or from the models chip on any stage.',
                )
              : t('No model mix matches.')}
          </p>
        </div>
      )}
      <ul className="crew-cards" aria-label={t('Model mixes')}>
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
