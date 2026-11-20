import { useState, type ReactElement } from 'react';

export function NumberField({
  label,
  value,
  step,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  max: number;
  onCommit: (value: number) => void;
}): ReactElement {
  // What is typed stays until the field is left; then the stored value shows again.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? String(value);
  return (
    <label className="field compact">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min={0}
        max={max}
        step={step}
        value={text}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
        onBlur={() => {
          const next = Number(text);
          setTyped(null);
          if (Number.isFinite(next) && next >= 0 && next <= max && next !== value) onCommit(next);
        }}
      />
    </label>
  );
}
