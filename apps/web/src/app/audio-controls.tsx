import { useId, useState, type ReactElement } from 'react';

/** A number the person types, committed on Enter or when they leave the field. */
export function NumberInput({
  label,
  value,
  step,
  min,
  max,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (value: number) => void;
}): ReactElement {
  const id = useId();
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? String(Math.round(value * 1000) / 1000);
  return (
    <div className="knob">
      <label htmlFor={id}>{label}</label>
      <span className="knob-input">
        <input
          id={id}
          className="input"
          type="number"
          step={step}
          min={min}
          max={max}
          value={text}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          onBlur={() => {
            const next = Number(text);
            setTyped(null);
            if (Number.isFinite(next) && next !== value) {
              onCommit(Math.min(max, Math.max(min, next)));
            }
          }}
        />
        {unit !== undefined && <span className="muted">{unit}</span>}
      </span>
    </div>
  );
}
