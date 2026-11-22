import {
  CaretDownIcon,
  CheckIcon,
  FloppyDiskIcon,
  SlidersHorizontalIcon,
} from '@phosphor-icons/react';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive, type Live } from './context.js';
import { ModelPicker, type Act, type useModelSetting } from './movie.js';

export const ModelMixes = z.object({
  mixes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      notes: z.string(),
      models: z.record(z.string(), z.string()),
      updatedAt: z.string(),
    }),
  ),
  active: z.string().nullable(),
  changed: z.boolean(),
  current: z.record(z.string(), z.string()),
  slots: z.array(z.object({ setting: z.string(), label: z.string() })),
});
export type ModelMixes = z.infer<typeof ModelMixes>;

/** The model mixes, the active one, and the models in use, kept current. */
export function useModelMixes(): Live<ModelMixes> {
  return useLive(['model-mixes/', 'settings/'], async (imp) =>
    ModelMixes.parse(await runCommand(imp, 'models.mix.list', {})),
  );
}

/** One model a stage uses, with the setting behind it. */
export interface StageModel {
  readonly id: string;
  readonly label: string;
  readonly empty: string;
  readonly setting: string;
  readonly choice: ReturnType<typeof useModelSetting>;
}

/** A model's name without its maker, short enough for the chip. */
function shortName(choice: StageModel['choice']): string | null {
  if (choice.model === null) return null;
  const known = choice.models.find((model) => model.id === choice.model);
  const name = known?.name ?? choice.model.replace(/^~/, '').split('/').pop() ?? choice.model;
  return name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : name;
}

/** "video model", "video and voice models": what the chip asks for while models are missing. */
function chooseText(labels: readonly string[]): string {
  const last = labels.at(-1) ?? '';
  const head = labels.slice(0, -1);
  return `${head.length === 0 ? '' : `${head.join(', ')} and `}${last} model${labels.length > 1 ? 's' : ''}`;
}

/**
 * The models of a stage, folded into one chip: which model mix is in use and
 * which models this stage makes things with. Opening it switches the whole
 * mix, changes a single model, or saves the models as a mix of their own.
 */
export function ModelBar({
  models,
  act,
  note,
}: {
  models: readonly StageModel[];
  act: Act;
  note?: ReactNode;
}): ReactElement {
  const imp = useImp();
  const panelId = useId();
  const nameId = useId();
  const mixes = useModelMixes().data;
  const missing = models.some((model) => model.choice.model === null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  // Open by itself while a model is still to be chosen, so the stage can be used at once.
  const shown = open ?? missing;
  const active = mixes?.mixes.find((mix) => mix.id === mixes.active) ?? null;
  const names = models.map((model) => shortName(model.choice));

  const run = (id: string, input: Record<string, unknown>, done: string): void => {
    setStatus(null);
    runCommand(imp, id, input).then(
      () => {
        setStatus({ text: done, error: false });
      },
      (reason: unknown) => {
        setStatus({ text: messageOf(reason), error: true });
      },
    );
  };

  return (
    <section className={`model-bar${shown ? ' open' : ''}`} aria-label="Models">
      <button
        type="button"
        className={`model-chip${missing ? ' missing' : ''}`}
        aria-expanded={shown}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!shown);
        }}
      >
        <SlidersHorizontalIcon aria-hidden="true" />
        <span className="model-chip-mix">{active?.name ?? 'Models'}</span>
        {active !== null && mixes?.changed === true && (
          <span className="model-chip-flag">changed</span>
        )}
        <span className="model-chip-models">
          {missing
            ? `Choose ${chooseText(
                models
                  .filter((model) => model.choice.model === null)
                  .map((model) => model.label.toLowerCase()),
              )}`
            : names.join(' · ')}
        </span>
        <CaretDownIcon aria-hidden="true" className="model-chip-caret" />
      </button>
      {shown && (
        <div id={panelId} className="model-panel stack">
          {mixes !== undefined && mixes.mixes.length > 0 && (
            <div className="model-mixes row wrap" role="group" aria-label="Model mixes">
              <span className="eyebrow">Mixes</span>
              {mixes.mixes.map((mix) => (
                <button
                  key={mix.id}
                  type="button"
                  className="button small"
                  aria-pressed={mix.id === mixes.active}
                  title={mix.notes || undefined}
                  onClick={() => {
                    run('models.mix.apply', { id: mix.id }, `Using “${mix.name}”.`);
                  }}
                >
                  {mix.id === mixes.active && <CheckIcon aria-hidden="true" />} {mix.name}
                </button>
              ))}
            </div>
          )}
          <div className="row wrap model-pickers">
            {models.map((model) => (
              <ModelPicker
                key={model.id}
                id={model.id}
                label={`${model.label} model`}
                empty={model.empty}
                setting={model.setting}
                choice={model.choice}
                act={act}
              />
            ))}
          </div>
          {note !== undefined && <p className="muted">{note}</p>}
          <div className="row wrap">
            {active !== null && mixes?.changed === true && (
              <button
                type="button"
                className="button small"
                onClick={() => {
                  run(
                    'models.mix.save',
                    { id: active.id },
                    `“${active.name}” now holds these models.`,
                  );
                }}
              >
                <FloppyDiskIcon aria-hidden="true" /> Update “{active.name}”
              </button>
            )}
            {naming ? (
              <form
                className="row wrap"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (name.trim() === '') return;
                  run(
                    'models.mix.save',
                    { name: name.trim() },
                    `Saved “${name.trim()}” in the library.`,
                  );
                  setNaming(false);
                  setName('');
                }}
              >
                <label className="sr-only" htmlFor={nameId}>
                  Name of the mix
                </label>
                <input
                  id={nameId}
                  className="input"
                  placeholder="Name, e.g. Cheap drafts"
                  value={name}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just asked to name it
                  autoFocus
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
                <button type="submit" className="button small" disabled={name.trim() === ''}>
                  Save
                </button>
                <button
                  type="button"
                  className="button quiet small"
                  onClick={() => {
                    setNaming(false);
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="button quiet small"
                disabled={mixes !== undefined && Object.keys(mixes.current).length === 0}
                onClick={() => {
                  setNaming(true);
                }}
              >
                <FloppyDiskIcon aria-hidden="true" /> Save all models as a mix
              </button>
            )}
          </div>
          {status !== null && (
            <p
              role={status.error ? 'alert' : 'status'}
              className={status.error ? 'error' : 'muted'}
            >
              {status.text}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
