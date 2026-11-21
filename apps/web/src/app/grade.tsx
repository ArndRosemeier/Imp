import { useId, useState, type ReactElement } from 'react';
import { z } from 'zod';
import type { Item } from './cut-player.js';

type Run = (id: string, input: Record<string, unknown>) => Promise<unknown>;

export interface GradeValues {
  exposure: number;
  contrast: number;
  temperature: number;
  tint: number;
  saturation: number;
}

/** The grade controls, in the words of a colourist, with their ranges. */
export const GRADE_CONTROLS: readonly {
  field: keyof GradeValues;
  label: string;
  min: number;
  max: number;
  low: string;
  high: string;
}[] = [
  { field: 'exposure', label: 'Exposure', min: -3, max: 3, low: 'Darker', high: 'Brighter' },
  { field: 'contrast', label: 'Contrast', min: -1, max: 1, low: 'Flatter', high: 'Punchier' },
  { field: 'temperature', label: 'Temperature', min: -1, max: 1, low: 'Cooler', high: 'Warmer' },
  { field: 'tint', label: 'Tint', min: -1, max: 1, low: 'Green', high: 'Magenta' },
  { field: 'saturation', label: 'Saturation', min: -1, max: 1, low: 'Grey', high: 'Vivid' },
];

export const PRESET_LABELS: Record<string, string> = {
  none: 'None',
  warm: 'Warm',
  cool: 'Cool',
  'bleach-bypass': 'Bleach bypass',
  noir: 'Noir',
  golden: 'Golden hour',
  night: 'Night',
};

export const LookView = z.object({
  look: z.object({
    exposure: z.number(),
    contrast: z.number(),
    temperature: z.number(),
    tint: z.number(),
    saturation: z.number(),
    preset: z.string().nullable(),
  }),
  presets: z.array(z.string()),
  canMatch: z.boolean().default(false),
});
export type LookView = z.infer<typeof LookView>;

export const isNeutralGrade = (grade: GradeValues): boolean =>
  GRADE_CONTROLS.every((control) => Math.abs(grade[control.field]) < 0.005);

const signed = (value: number): string =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}`;

/**
 * One grade control: dragged freely, sent once when let go, so that a drag is
 * one step of undo rather than a hundred. A double tap puts it back to zero.
 */
export function GradeSlider({
  label,
  value,
  min,
  max,
  low,
  high,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  low: string;
  high: string;
  onCommit: (value: number) => void;
}): ReactElement {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const commit = (): void => {
    if (dragging !== null && Math.abs(dragging - value) >= 0.005) onCommit(dragging);
    setDragging(null);
  };
  return (
    <label className="field compact grade-slider">
      <span className="row spread">
        <span>{label}</span>
        <span className="muted tabular">{signed(shown)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={shown}
        aria-label={label}
        aria-valuetext={`${signed(shown)}, ${shown < 0 ? low : shown > 0 ? high : 'unchanged'}`}
        onChange={(event) => {
          setDragging(Number(event.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        onDoubleClick={() => {
          setDragging(null);
          if (value !== 0) onCommit(0);
        }}
      />
    </label>
  );
}

/**
 * The colour of a shot: its own grade before the film's look, and matching it
 * to another shot of the scene. The same fields and commands agents use.
 */
export function GradeTools({
  item,
  items,
  run,
  canMatch,
}: {
  item: Item;
  /** The pieces of the scene, to match to. */
  items: readonly Item[];
  run: Run;
  /** Whether this host can read the colours of clips. */
  canMatch: boolean;
}): ReactElement | null {
  const titleId = useId();
  const [matching, setMatching] = useState(false);
  const [problem, setProblem] = useState('');
  if (item.kind !== 'shot' || item.placeholder || item.durationSeconds <= 0) return null;
  const others = items.filter(
    (other) =>
      other.itemId !== item.itemId &&
      other.kind === 'shot' &&
      !other.placeholder &&
      other.durationSeconds > 0,
  );
  const set = (fields: Partial<GradeValues>): void => {
    void run('movie.edit.item.set', { itemId: item.itemId, grade: fields });
  };
  return (
    <section className="stack grade-tools" aria-labelledby={titleId}>
      <div className="row spread wrap">
        <h4 id={titleId}>Colour</h4>
        {!isNeutralGrade(item.grade) && (
          <button
            className="button small quiet"
            onClick={() => {
              set({ exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0 });
            }}
          >
            As filmed
          </button>
        )}
      </div>
      <div className="grade-grid">
        {GRADE_CONTROLS.map((control) => (
          <GradeSlider
            key={control.field}
            label={control.label}
            value={item.grade[control.field]}
            min={control.min}
            max={control.max}
            low={control.low}
            high={control.high}
            onCommit={(value) => {
              set({ [control.field]: value });
            }}
          />
        ))}
      </div>
      {canMatch && others.length > 0 && (
        <label className="field compact">
          <span>Match colour to</span>
          <select
            className="input"
            value=""
            disabled={matching}
            onChange={(event) => {
              const toItemId = event.target.value;
              if (toItemId === '') return;
              setMatching(true);
              setProblem('');
              run('movie.edit.grade.match', { itemId: item.itemId, toItemId })
                .catch((error: unknown) => {
                  setProblem(error instanceof Error ? error.message : String(error));
                })
                .finally(() => {
                  setMatching(false);
                });
            }}
          >
            <option value="">{matching ? 'Matching…' : 'Choose a shot'}</option>
            {others.map((other) => (
              <option key={other.itemId} value={other.itemId}>
                Shot {other.index} · {other.label.slice(0, 48) || 'Untitled'}
              </option>
            ))}
          </select>
        </label>
      )}
      {problem !== '' && <p className="problem small">{problem}</p>}
    </section>
  );
}

/** The look of the whole film: a preset to start from, then its grade, over every shot. */
export function FilmLookPanel({
  view,
  run,
  onClose,
}: {
  view: LookView;
  run: Run;
  onClose: () => void;
}): ReactElement {
  const titleId = useId();
  const { look } = view;
  return (
    <section className="stack film-look" aria-labelledby={titleId}>
      <div className="row spread wrap">
        <h3 id={titleId}>Look of the film</h3>
        <button className="button small quiet" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="muted small">
        Laid over every shot after its own colour. Make the shots of a scene agree first, then give
        the film one feel.
      </p>
      <div className="look-presets" role="group" aria-label="Preset looks">
        {view.presets.map((preset) => (
          <button
            key={preset}
            className={`look-preset look-${preset}`}
            aria-pressed={look.preset === preset}
            onClick={() => {
              void run('movie.edit.look.set', { preset });
            }}
          >
            <span className="look-swatch" aria-hidden="true" />
            {PRESET_LABELS[preset] ?? preset}
          </button>
        ))}
      </div>
      <div className="grade-grid">
        {GRADE_CONTROLS.map((control) => (
          <GradeSlider
            key={control.field}
            label={control.label}
            value={look[control.field]}
            min={control.min}
            max={control.max}
            low={control.low}
            high={control.high}
            onCommit={(value) => {
              void run('movie.edit.look.set', { [control.field]: value });
            }}
          />
        ))}
      </div>
    </section>
  );
}
