import { ArrowRightIcon, ChatCircleDotsIcon, type Icon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import { OPEN_VIEW } from '../library/model.js';
import { askCoordinator } from './help.js';
import { HornedBadge } from '../ImpMark.js';
import { t } from '../../i18n/i18n.js';

/**
 * What a stage shows while it has nothing to show: what belongs here, and the
 * two ways to fill it, by hand (where the stage's own Add button is) or by
 * asking the coordinator. It stays on for pros too, because an empty stage
 * has nothing else to say.
 */
export function EmptyState({
  icon: Glyph,
  title,
  body,
  quip,
  ask,
  go,
}: {
  icon: Icon;
  title: string;
  body: string;
  /** A short aside in the imp's voice, shown small under the title. */
  quip?: string;
  /** What to put in the coordinator's message box. Nothing is sent until the person presses Send. */
  ask?: string;
  /** Another stage to fill first, such as the script before shots. */
  go?: { stage: string; label: string };
}): ReactElement {
  return (
    <section className="empty-state" aria-label={title}>
      <HornedBadge>
        <Glyph className="empty-state-icon" aria-hidden="true" size={26} weight="duotone" />
      </HornedBadge>
      <h2>{title}</h2>
      {quip !== undefined && <p className="empty-state-quip">{quip}</p>}
      <p className="muted">{body}</p>
      <div className="row wrap empty-state-actions">
        {go !== undefined && (
          <button
            className="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent(OPEN_VIEW, { detail: go.stage }));
            }}
          >
            {go.label} <ArrowRightIcon aria-hidden="true" />
          </button>
        )}
        {ask !== undefined && (
          <button
            className="button quiet"
            title={t(
              "Puts the request in the coordinator's message box. Nothing is sent until you press Send.",
            )}
            onClick={() => {
              askCoordinator(ask);
            }}
          >
            <ChatCircleDotsIcon aria-hidden="true" /> {t('Ask the coordinator')}
          </button>
        )}
      </div>
    </section>
  );
}
