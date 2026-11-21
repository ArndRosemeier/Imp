import { useId, useState, type ReactElement } from 'react';
import type { Item } from './cut-player.js';

type Run = (id: string, input: Record<string, unknown>) => Promise<unknown>;

/** What the inspector says about a pickup that waits for its clip. */
export function PickupNote({ item }: { item: Item }): ReactElement | null {
  if (!item.placeholder) return null;
  return (
    <div className="pickup-note stack">
      <p>
        <strong>Pickup to come.</strong> It stands here as a slate of{' '}
        {item.durationSeconds.toFixed(1)} s until its clip is ready, then the clip takes its place.
      </p>
      {item.pickupReason !== null && item.pickupReason !== '' && (
        <p className="muted">Needed for: {item.pickupReason}</p>
      )}
      <p className="muted small">
        Make its clip on the Shots screen, or ask the Clip Designer, who finds it with the open
        pickups.
      </p>
    </div>
  );
}

/**
 * Asks for a shot the cut needs and does not have, right after a piece: a
 * reaction, an insert, a cutaway. The same command the Film Editor uses.
 */
export function PickupRequest({
  afterIndex,
  run,
}: {
  /** The place in the cut, counted from 0, that the new shot goes to. */
  afterIndex: number;
  run: Run;
}): ReactElement {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [seconds, setSeconds] = useState(3);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (!open) {
    return (
      <button
        className="button small quiet"
        onClick={() => {
          setOpen(true);
        }}
      >
        Ask for a shot after this
      </button>
    );
  }
  const send = (): void => {
    setBusy(true);
    setProblem('');
    run('movie.edit.pickup.request', {
      description: description.trim(),
      reason: reason.trim(),
      seconds,
      toIndex: afterIndex,
    })
      .then(() => {
        setOpen(false);
        setDescription('');
        setReason('');
        setSeconds(3);
      })
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const ready = description.trim() !== '' && reason.trim() !== '' && !busy;
  return (
    <section className="stack pickup-request" aria-labelledby={titleId}>
      <h4 id={titleId}>Pickup shot</h4>
      <p className="muted small">
        A shot the cut needs and does not have. It goes in as a slate until its clip is made.
      </p>
      <label className="field compact">
        <span>What the camera shows</span>
        <textarea
          className="input"
          rows={3}
          value={description}
          placeholder="Close-up of Mara's hands tightening on the rail"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      <label className="field compact">
        <span>What the cut needs it for</span>
        <input
          className="input"
          value={reason}
          placeholder="Covers the jump in her answer"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
      <label className="field compact">
        <span>How long (s)</span>
        <input
          className="input"
          type="number"
          min={0.5}
          max={30}
          step={0.5}
          value={seconds}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) setSeconds(Math.min(30, Math.max(0.5, value)));
          }}
        />
      </label>
      <div className="row wrap">
        <button className="button primary small" disabled={!ready} onClick={send}>
          {busy ? 'Asking…' : 'Put it in the cut'}
        </button>
        <button
          className="button small quiet"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
      {problem !== '' && <p className="problem small">{problem}</p>}
    </section>
  );
}
