import { useId, useState, type ReactElement } from 'react';
import { messageOf } from './context.js';

/**
 * A text field bound to stored data. It saves when the user leaves it, and
 * takes over a new stored value whenever someone else, such as an agent,
 * changes it.
 */
export function EditableField({
  label,
  value,
  onCommit,
  rows,
  placeholder,
  script = false,
  hideLabel = false,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => Promise<unknown>;
  /** More than one row makes it a text area. */
  rows?: number;
  placeholder?: string;
  /** Set in the screenplay typeface. */
  script?: boolean;
  hideLabel?: boolean;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [stored, setStored] = useState(value);
  const [error, setError] = useState<string | null>(null);
  if (value !== stored) {
    setStored(value);
    setDraft(value);
  }

  const shared = {
    id,
    className: script ? 'input script' : 'input',
    value: draft,
    placeholder,
    onChange: (event: { target: { value: string } }): void => {
      setDraft(event.target.value);
    },
    onBlur: (): void => {
      if (draft === value) return;
      setError(null);
      onCommit(draft).catch((reason: unknown) => {
        setError(messageOf(reason));
      });
    },
  };

  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </label>
      {rows === undefined ? (
        <input type="text" {...shared} />
      ) : (
        <textarea rows={rows} {...shared} />
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A button for something that cannot be undone: the first press asks, the second acts. */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  children,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
  children: ReactElement;
}): ReactElement {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        className="button quiet"
        onClick={() => {
          setAsking(true);
        }}
      >
        {children} {label}
      </button>
    );
  }
  return (
    <span className="row" role="group" aria-label={question}>
      <span className="muted">{question}</span>
      <button
        className="button danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Delete
      </button>
      <button
        className="button quiet"
        onClick={() => {
          setAsking(false);
        }}
      >
        Keep
      </button>
    </span>
  );
}
