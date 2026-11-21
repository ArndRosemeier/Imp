import type { Shot } from '@imp/mode-movie';
import { useId, useState, type ReactElement } from 'react';
import type { Item } from './cut-player.js';

type Run = (id: string, input: Record<string, unknown>) => Promise<unknown>;

const seconds = (value: number): string => `${String(Math.round(value * 100) / 100)} s`;

/** Why a split edit of a length cannot be made between two pieces, or null when it can. */
type Retimed = 'speed' | 'reverse' | 'holdSeconds';

export function splitEditBlock(
  item: Pick<Item, 'kind' | 'durationSeconds' | 'trimEndSeconds' | Retimed>,
  next: Pick<Item, 'kind' | 'durationSeconds' | 'trimStartSeconds' | Retimed> | undefined,
  type: 'j' | 'l',
  length: number,
): string | null {
  if (next === undefined) return 'This is the last piece of the scene.';
  if (item.kind !== 'shot' || next.kind !== 'shot') return 'Both pieces must be shots.';
  if (item.durationSeconds <= 0 || next.durationSeconds <= 0) {
    return 'Both pieces need a ready clip.';
  }
  const plain = (piece: Pick<Item, Retimed>): boolean =>
    piece.speed === 1 && !piece.reverse && piece.holdSeconds === 0;
  if (!plain(item) || !plain(next)) {
    return 'Both shots must play at their own speed, forwards, without a held frame.';
  }
  if (!(length > 0)) return 'Give a length above 0.';
  if (type === 'l') {
    if (next.trimStartSeconds + 0.001 < length) {
      return `The next shot has ${seconds(next.trimStartSeconds)} trimmed off its start; an L cut of ${seconds(length)} needs that much to show.`;
    }
    if (item.durationSeconds - length < 0.2) return 'That leaves this picture too short.';
  } else {
    if (item.trimEndSeconds + 0.001 < length) {
      return `This shot has ${seconds(item.trimEndSeconds)} trimmed off its end; a J cut of ${seconds(length)} needs that much to show.`;
    }
    if (next.durationSeconds - length < 0.2) return 'That leaves the next picture too short.';
  }
  return null;
}

/**
 * J and L cuts with the next piece: the picture changes before or after the
 * sound does. The same command the Film Editor uses, so both edit alike.
 */
export function SplitEdit({
  item,
  next,
  run,
}: {
  item: Item;
  next: Item | undefined;
  run: Run;
}): ReactElement | null {
  const lengthId = useId();
  const [length, setLength] = useState(0.5);
  if (item.kind !== 'shot' || next?.kind !== 'shot') return null;
  const blocks = {
    j: splitEditBlock(item, next, 'j', length),
    l: splitEditBlock(item, next, 'l', length),
  };
  const roll = (type: 'j' | 'l'): void => {
    void run('movie.edit.item.roll', { itemId: item.itemId, type, seconds: length });
  };
  return (
    <section className="stack split-edit" aria-labelledby={`${lengthId}-title`}>
      <div className="row spread wrap">
        <h4 id={`${lengthId}-title`}>Split edit with the next shot</h4>
        <label className="field compact split-length">
          <span>Overlap (s)</span>
          <input
            id={lengthId}
            className="input"
            type="number"
            min={0.1}
            max={5}
            step={0.1}
            value={length}
            onChange={(event) => {
              setLength(Number(event.target.value));
            }}
          />
        </label>
      </div>
      <div className="split-choices">
        <button
          className="button split-choice"
          disabled={blocks.j !== null}
          title={blocks.j ?? 'Picture cuts later: the next sound starts under this shot.'}
          onClick={() => {
            roll('j');
          }}
        >
          <SplitDiagram type="j" />
          <span>
            <strong>J cut</strong>
            <span className="muted small">Hear the next shot first</span>
          </span>
        </button>
        <button
          className="button split-choice"
          disabled={blocks.l !== null}
          title={blocks.l ?? 'Picture cuts earlier: this sound runs on under the next shot.'}
          onClick={() => {
            roll('l');
          }}
        >
          <SplitDiagram type="l" />
          <span>
            <strong>L cut</strong>
            <span className="muted small">Let this sound run on</span>
          </span>
        </button>
      </div>
      {blocks.j !== null && blocks.l !== null && (
        <p className="muted small">
          A split edit shows picture that was trimmed off. Trim this shot&apos;s end for a J cut, or
          the next shot&apos;s start for an L cut.
        </p>
      )}
    </section>
  );
}

/** A picture lane over a sound lane, with the sound's cut ahead of (J) or behind (L) the picture's. */
function SplitDiagram({ type }: { type: 'j' | 'l' }): ReactElement {
  const cutPicture = type === 'j' ? 22 : 14;
  const cutSound = type === 'j' ? 14 : 22;
  return (
    <svg className="split-diagram" viewBox="0 0 36 20" aria-hidden="true">
      <rect x="1" y="2" width={cutPicture - 2} height="6" rx="1.5" className="a" />
      <rect x={cutPicture} y="2" width={35 - cutPicture} height="6" rx="1.5" className="b" />
      <rect x="1" y="12" width={cutSound - 2} height="6" rx="1.5" className="a sound" />
      <rect x={cutSound} y="12" width={35 - cutSound} height="6" rx="1.5" className="b sound" />
    </svg>
  );
}

/** The takes of the shot a piece plays, to swap the piece's picture for an earlier one. */
export function TakeSwitcher({
  shot,
  run,
}: {
  shot: Shot | undefined;
  run: Run;
}): ReactElement | null {
  const pickerId = useId();
  if (shot === undefined || shot.takes.length === 0) return null;
  const pending = shot.clip?.status === 'pending';
  return (
    <div className="stack take-switcher">
      <label className="field compact" htmlFor={pickerId}>
        <span>Take</span>
        <select
          id={pickerId}
          className="input"
          value=""
          disabled={pending}
          onChange={(event) => {
            if (event.target.value === '') return;
            void run('movie.shot.take.use', {
              sceneId: shot.sceneId,
              shotId: shot.id,
              blobKey: event.target.value,
            });
          }}
        >
          <option value="">The take in use</option>
          {shot.takes.map((take, index) => (
            <option key={take.blobKey ?? index} value={take.blobKey ?? ''}>
              Earlier take {index + 1}
              {take.durationSeconds === null ? '' : `, ${String(take.durationSeconds)} s`}
            </option>
          ))}
        </select>
      </label>
      <span className="muted small">
        {pending
          ? 'A new clip is being made.'
          : `${String(shot.takes.length)} earlier ${shot.takes.length === 1 ? 'take' : 'takes'}; trims are kept.`}
      </span>
    </div>
  );
}
