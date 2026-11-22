import { ArrowLeftIcon, PlayIcon, XIcon } from '@phosphor-icons/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
  type ReactElement,
} from 'react';
import type { CommandInfo } from '@imp/host';
import { messageOf, runCommand, useImp } from './context.js';
import { t, tx } from '../i18n/i18n.js';

interface Field {
  readonly name: string;
  readonly kind: 'string' | 'number' | 'boolean' | 'json';
  readonly required: boolean;
  readonly description: string | undefined;
}

/** Derives form fields from the same schema an agent receives as tool parameters. */
export function fieldsOf(command: CommandInfo): Field[] {
  const schema = command.input as {
    properties?: Record<string, { type?: unknown; description?: string }>;
    required?: string[];
  };
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    kind:
      property.type === 'string'
        ? 'string'
        : property.type === 'number' || property.type === 'integer'
          ? 'number'
          : property.type === 'boolean'
            ? 'boolean'
            : 'json',
    required: schema.required?.includes(name) ?? false,
    description: property.description,
  }));
}

/** Turns what was typed into the input object, leaving out fields left empty. */
export function toInput(fields: readonly Field[], values: Record<string, string>): unknown {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? '';
    if (field.kind === 'boolean') {
      // An untouched box says nothing, so the command's own default applies.
      if (raw !== '') input[field.name] = raw === 'true';
    } else if (raw.trim() !== '') {
      input[field.name] =
        field.kind === 'number' ? Number(raw) : field.kind === 'json' ? JSON.parse(raw) : raw;
    }
  }
  return input;
}

function CommandForm({
  command,
  onBack,
}: {
  command: CommandInfo;
  onBack: () => void;
}): ReactElement {
  const imp = useImp();
  const fields = useMemo(() => fieldsOf(command), [command]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setError(null);
    setResult(null);
    Promise.resolve()
      .then(() => runCommand(imp, command.id, toInput(fields, values)))
      .then(
        (output) => {
          setResult(JSON.stringify(output, null, 2));
        },
        (reason: unknown) => {
          setError(messageOf(reason));
        },
      );
  };

  return (
    <form className="palette-form stack" onSubmit={submit}>
      <div className="row">
        <button type="button" className="button quiet" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" /> {t('All commands')}
        </button>
      </div>
      <h2>{tx(command.title)}</h2>
      <p className="muted">{command.description}</p>
      {fields.map((field, index) => (
        <label key={field.name} className="field">
          <span>
            {field.name}
            {field.required ? '' : ` ${t('(optional)')}`}
            {field.description === undefined ? '' : ` · ${field.description}`}
          </span>
          {field.kind === 'boolean' ? (
            <select
              className="input"
              value={values[field.name] ?? ''}
              onChange={(event) => {
                setValues({ ...values, [field.name]: event.target.value });
              }}
            >
              <option value="">{t('As it is by default')}</option>
              <option value="false">{t('No')}</option>
              <option value="true">{t('Yes')}</option>
            </select>
          ) : (
            <input
              className="input"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog was opened to fill this in
              autoFocus={index === 0}
              inputMode={field.kind === 'number' ? 'decimal' : undefined}
              placeholder={field.kind === 'json' ? t('JSON value') : undefined}
              required={field.required}
              value={values[field.name] ?? ''}
              onChange={(event) => {
                setValues({ ...values, [field.name]: event.target.value });
              }}
            />
          )}
        </label>
      ))}
      <div className="row">
        <button className="button primary">
          <PlayIcon aria-hidden="true" /> {t('Run')}
        </button>
        <span className="effect" data-effect={command.effect}>
          {command.id} · {command.effect}
        </span>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result !== null && (
        <pre className="result" aria-label={t('Result')}>
          {result}
        </pre>
      )}
    </form>
  );
}

/** Every registered command, searchable and runnable. The list is the registry itself. */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const imp = useImp();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CommandInfo | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setQuery('');
      setSelected(null);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const needle = query.trim().toLowerCase();
  const commands = imp.commands.filter((command) =>
    `${command.id} ${command.title} ${tx(command.title)} ${command.description}`
      .toLowerCase()
      .includes(needle),
  );

  return (
    // A tap on the dimmed backdrop lands on the dialog itself and closes it, as Escape does;
    // a tablet has no Escape key.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={dialog}
      className="palette"
      aria-label={t('Commands')}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      {selected === null ? (
        <>
          <div className="palette-head">
            <input
              className="input palette-search"
              aria-label={t('Search commands')}
              placeholder={t('Search commands')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            <button
              type="button"
              className="button quiet"
              aria-label={t('Close commands')}
              onClick={() => {
                dialog.current?.close();
              }}
            >
              <XIcon aria-hidden="true" />
            </button>
          </div>
          <ul className="palette-list">
            {commands.map((command) => (
              <li key={command.id}>
                <button
                  className="palette-option"
                  onClick={() => {
                    setSelected(command);
                  }}
                >
                  <span>{tx(command.title)}</span>
                  <span className="effect" data-effect={command.effect}>
                    {command.id}
                  </span>
                  <span className="muted">{command.description}</span>
                </button>
              </li>
            ))}
            {commands.length === 0 && (
              <li className="muted palette-option">{t('No command matches.')}</li>
            )}
          </ul>
        </>
      ) : (
        <CommandForm
          command={selected}
          onBack={() => {
            setSelected(null);
          }}
        />
      )}
    </dialog>
  );
}
