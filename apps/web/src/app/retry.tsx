import { isRetryable } from '@imp/core';
import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';
import { ImpSpinner } from './ImpMark.js';
import { t } from '../i18n/i18n.js';

/** Something that failed and can be sent again, with the failure it answers. */
export interface Retry {
  /** The failure this retry belongs to: a note shows the button only beside this text. */
  readonly text: string;
  readonly run: () => Promise<unknown>;
}

/** Whether a failure is worth a Retry button: the cause was outside Imp, such as the network. */
export function canRetry(error: unknown): boolean {
  return isRetryable(error);
}

/**
 * A failure in plain words, with a Retry button that sends the same thing
 * again. While it is trying, the button turns into the imp's spinner, so a
 * second press cannot send it twice.
 */
export function RetryNote({
  text,
  onRetry,
  heading,
  role = 'alert',
}: {
  text: string;
  /** Left out, the note only explains. */
  onRetry?: (() => Promise<unknown>) | undefined;
  /** A short line above the text, such as who did not get a message. */
  heading?: string;
  role?: 'alert' | 'status';
}): ReactElement {
  const [trying, setTrying] = useState(false);
  if (onRetry === undefined) {
    return (
      <p className="error" role={role}>
        {text}
      </p>
    );
  }
  return (
    <div className="retry-note" role={role}>
      <WarningCircleIcon aria-hidden="true" size={20} className="retry-icon" />
      <div className="stack retry-words">
        {heading !== undefined && <strong>{heading}</strong>}
        <span>{text}</span>
      </div>
      <button
        type="button"
        className="button small retry-button"
        disabled={trying}
        onClick={() => {
          setTrying(true);
          onRetry()
            .catch(() => undefined)
            .finally(() => {
              setTrying(false);
            });
        }}
      >
        {trying ? (
          <>
            <ImpSpinner /> {t('Trying again')}
          </>
        ) : (
          <>
            <ArrowClockwiseIcon aria-hidden="true" /> {t('Retry')}
          </>
        )}
      </button>
    </div>
  );
}
