import { useId, type ReactElement } from 'react';
import type { Item } from './cut-player.js';
import { NumberField } from './NumberField.js';
import { t } from '../i18n/i18n.js';

type Run = (id: string, input: Record<string, unknown>) => Promise<unknown>;

/** The transitions offered, in the words of an editor. */
export const TRANSITIONS: readonly { kind: Item['transition']; label: string; hint: string }[] = [
  {
    kind: 'cut',
    get label(): string {
      return t('Cut');
    },
    get hint(): string {
      return t('Straight cut, no transition');
    },
  },
  {
    kind: 'dissolve',
    get label(): string {
      return t('Dissolve');
    },
    get hint(): string {
      return t('Fades over the shot before');
    },
  },
  {
    kind: 'dip-black',
    get label(): string {
      return t('Dip to black');
    },
    get hint(): string {
      return t('The shot before fades to black, this one fades up');
    },
  },
  {
    kind: 'dip-white',
    get label(): string {
      return t('Dip to white');
    },
    get hint(): string {
      return t('Through a flash of white');
    },
  },
  {
    kind: 'wipe',
    get label(): string {
      return t('Wipe');
    },
    get hint(): string {
      return t('Wipes across the shot before, left to right');
    },
  },
];

/** What a transition does to the scene, said plainly. */
export function transitionNote(item: Pick<Item, 'transition' | 'overlapSeconds'>): string {
  if (item.transition === 'cut') return '';
  if (item.transition === 'dissolve' || item.transition === 'wipe') {
    return item.overlapSeconds > 0
      ? t('Lies over the shot before for {overlapSeconds} s, so the scene is that much shorter.', {
          overlapSeconds: String(item.overlapSeconds),
        })
      : t('There is no room to overlap the piece before.');
  }
  return t('Fades out and in at the cut; the scene keeps its length.');
}

/**
 * How a piece comes in after the one before it: a cut, a dissolve, a dip to
 * black or white, or a wipe, and how long it takes. The same fields agents
 * set with movie.edit.item.set.
 */
export function TransitionPicker({ item, run }: { item: Item; run: Run }): ReactElement {
  const titleId = useId();
  const set = (fields: Record<string, unknown>): void => {
    void run('movie.edit.item.set', { itemId: item.itemId, ...fields });
  };
  const note = transitionNote(item);
  return (
    <section className="stack transition-picker" aria-labelledby={titleId}>
      <h4 id={titleId}>{t('Comes in with')}</h4>
      <span className="segmented wrap" role="group" aria-label={t('Transition')}>
        {TRANSITIONS.map((choice) => (
          <button
            key={choice.kind}
            aria-pressed={item.transition === choice.kind}
            title={choice.hint}
            onClick={() => {
              set({ transition: choice.kind });
            }}
          >
            {choice.label}
          </button>
        ))}
      </span>
      {item.transition !== 'cut' && (
        <NumberField
          label={t('Length (s)')}
          value={item.transitionSeconds}
          step={0.25}
          min={0.1}
          max={5}
          onCommit={(transitionSeconds) => {
            set({ transitionSeconds });
          }}
        />
      )}
      {note !== '' && <p className="muted small">{note}</p>}
    </section>
  );
}
