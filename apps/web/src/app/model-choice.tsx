import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp } from './context.js';
import { formatUsd } from './spend.js';
import { t } from '../i18n/i18n.js';

/** The setting that names the model the agents think with. */
export const AGENTS_MODEL_SETTING = 'coordinator.model';

const Listed = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      inputUsdPerMillion: z.number().nullable().optional(),
      outputUsdPerMillion: z.number().nullable().optional(),
      abilities: z.array(z.string()).optional(),
    }),
  ),
  total: z.number().optional(),
});
type Option = z.infer<typeof Listed>['models'][number];

/** A model as a picker knows it before the catalog has answered. */
export interface KnownModel {
  readonly id: string;
  readonly name: string;
  readonly abilities?: readonly string[] | undefined;
}

/** What a video model can do, in the interface's language; lengths such as "4–8 s" read the same in both. */
export function abilityLabel(ability: string): string {
  switch (ability) {
    case 'own sound':
      return t('makes its own sound');
    case 'no sound':
      return t('no sound');
    case 'start picture':
      return t('starts from a picture');
    default:
      return ability;
  }
}

/** A model's name without the maker in front, as the catalog writes "Maker: Name". */
function plainName(name: string): string {
  return name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : name;
}

function priceText(model: Option): string | null {
  const input = model.inputUsdPerMillion;
  const output = model.outputUsdPerMillion;
  if (input === null || input === undefined || output === null || output === undefined) {
    return null;
  }
  if (input === 0 && output === 0) return t('free, often busy');
  return t('{input} in, {output} out per million tokens', {
    input: formatUsd(input),
    output: formatUsd(output),
  });
}

/**
 * Sets the model a setting names. The agents' model is also the coordinator's
 * own, so changing it changes the coordinator too, as using a mix does.
 */
export async function chooseModel(
  run: (id: string, input: Record<string, unknown>) => Promise<unknown>,
  setting: string,
  model: string,
): Promise<void> {
  await run('settings.set', { key: setting, value: model });
  if (setting !== AGENTS_MODEL_SETTING) return;
  const member = z
    .object({ value: z.json() })
    .safeParse(await run('settings.get', { key: 'coordinator.member' }));
  if (member.success && typeof member.data.value === 'string') {
    await run('crew.update', { id: member.data.value, model });
  }
}

/** Touch screens get no keyboard thrown up just for opening the list. */
function typesFirst(): boolean {
  return typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Picks a model from the live catalog. The list opens under the field and is
 * searched as one types, so any model can be found, not only the first ones
 * the catalog lists. Each model shows its price, and video models what they
 * can do, such as whether they make their own sound.
 */
export function ModelChoice({
  id,
  label,
  empty,
  output,
  tools = false,
  value,
  known = [],
  onChoose,
}: {
  id: string;
  label: string;
  empty: string;
  output: string;
  tools?: boolean;
  value: string | null;
  known?: readonly KnownModel[];
  onChoose: (model: string) => Promise<void> | void;
}): ReactElement {
  const imp = useImp();
  const panelId = useId();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ models: Option[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  // Ask the catalog as the search changes, a moment after typing stops.
  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    const words = query.trim();
    const timer = window.setTimeout(
      () => {
        runCommand(imp, 'models.list', {
          output,
          tools,
          ...(words === '' ? {} : { search: words }),
        }).then(
          (listed) => {
            if (!current) return;
            const parsed = Listed.parse(listed);
            setFound({ models: parsed.models, total: parsed.total ?? parsed.models.length });
            setError(null);
            setActive(0);
          },
          (reason: unknown) => {
            if (current) setError(messageOf(reason));
          },
        );
      },
      words === '' ? 0 : 180,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [imp, open, query, output, tools]);

  // A tap or click anywhere else closes the list.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);

  useEffect(() => {
    if (open && typesFirst()) search.current?.focus();
  }, [open]);

  // The model in use may lie beyond the first ones the catalog lists; look it up by its id.
  const [named, setNamed] = useState<Option | null>(null);
  const listedCurrent = known.some((model) => model.id === value);
  useEffect(() => {
    if (value === null || listedCurrent) return undefined;
    let current = true;
    runCommand(imp, 'models.list', { output, search: value, all: true }).then(
      (listed) => {
        const match = Listed.parse(listed).models.find((model) => model.id === value);
        if (current && match !== undefined) setNamed(match);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [imp, value, listedCurrent, output]);

  const models = found?.models ?? [];
  const current =
    known.find((model) => model.id === value) ??
    models.find((model) => model.id === value) ??
    (named?.id === value ? named : undefined);
  const currentAbilities = current?.abilities ?? [];

  const choose = (model: string): void => {
    setOpen(false);
    setQuery('');
    if (model === value) return;
    setBusy(true);
    Promise.resolve(onChoose(model))
      .catch((reason: unknown) => {
        setError(messageOf(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, models.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = models[active];
      if (picked !== undefined) choose(picked.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const optionId = (index: number): string => `${listId}-${String(index)}`;

  return (
    <div className={`field model-picker model-choice${open ? ' open' : ''}`} ref={root}>
      <label htmlFor={id}>{label}</label>
      <button
        id={id}
        type="button"
        className={`model-choice-current${value === null ? ' empty' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="listbox"
        aria-busy={busy}
        title={value ?? undefined}
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span className="model-choice-text">
          <span className="model-choice-name">
            {value === null ? empty : plainName(current?.name ?? value)}
          </span>
          {value !== null && current !== undefined && (
            <span className="model-choice-id mono">
              {value}
              {currentAbilities.length > 0 &&
                ` · ${currentAbilities.map((ability) => abilityLabel(ability)).join(' · ')}`}
            </span>
          )}
        </span>
        <CaretDownIcon aria-hidden="true" className="model-choice-caret" />
      </button>
      {open && (
        <div id={panelId} className="model-choice-panel">
          <div className="model-choice-search">
            <MagnifyingGlassIcon aria-hidden="true" />
            <input
              ref={search}
              className="input"
              type="search"
              role="combobox"
              aria-label={t('Search for a model')}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={models.length > 0 ? optionId(active) : undefined}
              placeholder={t('Search by name or maker, e.g. veo')}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onKeyDown={onKey}
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label={t('Models found')}
            className="model-choice-list"
          >
            {models.map((model, index) => {
              // Prices per token mean something only for models that write; clips and pictures cost per piece.
              const price = output === 'text' ? priceText(model) : null;
              const abilities = model.abilities ?? [];
              return (
                // The search field above handles the keys; a tap or click picks here.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={model.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={model.id === value}
                  className={`model-choice-option${index === active ? ' active' : ''}`}
                  onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') setActive(index);
                  }}
                  onClick={() => {
                    choose(model.id);
                  }}
                >
                  <span className="model-choice-check" aria-hidden="true">
                    {model.id === value && <CheckIcon />}
                  </span>
                  <span className="model-choice-text">
                    <span className="model-choice-name">{plainName(model.name)}</span>
                    <span className="model-choice-id mono">{model.id}</span>
                    {(price !== null || abilities.length > 0) && (
                      <span className="model-choice-meta">
                        {abilities.map((ability) => (
                          <span
                            key={ability}
                            className={`model-choice-tag${ability === 'own sound' ? ' sound' : ''}`}
                          >
                            {abilityLabel(ability)}
                          </span>
                        ))}
                        {price !== null && <span>{price}</span>}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {found === null && error === null && (
            <p className="muted small" role="status">
              {t('Looking up models…')}
            </p>
          )}
          {found !== null && models.length === 0 && (
            <p className="muted small">{t('No model matches.')}</p>
          )}
          {found !== null && found.total > models.length && (
            <p className="muted small">
              {t('{shown} of {total} shown. Type to narrow the list.', {
                shown: models.length,
                total: found.total,
              })}
            </p>
          )}
        </div>
      )}
      {error !== null && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
