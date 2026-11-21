import {
  designBiquad,
  describeEffect,
  Effect,
  EqBand,
  responseDb,
  type EffectKind,
  type VoicePreset,
} from '@imp/audio';
import { ArrowUpIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { NumberInput } from './audio-controls.js';

type Edit = (id: string, input?: Record<string, unknown>) => Promise<unknown>;

const Report = z.object({
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number().nullable(),
});

/** What each kind is called, and what it is for, in a few words. */
const KINDS: readonly {
  kind: EffectKind;
  name: string;
  hint: string;
  group: 'clean' | 'voice';
}[] = [
  { kind: 'denoise', name: 'Noise reduction', hint: 'Hiss, hum, room tone', group: 'clean' },
  { kind: 'eq', name: 'EQ', hint: 'Tone: rumble, boxiness, clarity', group: 'clean' },
  { kind: 'compressor', name: 'Compressor', hint: 'Evens out loud and quiet', group: 'clean' },
  { kind: 'loudness', name: 'Loudness', hint: 'To a LUFS target', group: 'clean' },
  { kind: 'limiter', name: 'Limiter', hint: 'Keeps peaks under a ceiling', group: 'clean' },
  { kind: 'distortion', name: 'Distortion', hint: 'Overdrive, clipping, folding', group: 'voice' },
  { kind: 'pitch', name: 'Pitch', hint: 'Higher or lower, same length', group: 'voice' },
  { kind: 'ringmod', name: 'Ring modulator', hint: 'Robots and metal', group: 'voice' },
  { kind: 'crush', name: 'Bit crusher', hint: 'Lo-fi grit', group: 'voice' },
];

/** The ready-made voices, in the order offered. */
const VOICES: readonly { preset: VoicePreset; name: string }[] = [
  { preset: 'telephone', name: 'Telephone' },
  { preset: 'radio', name: 'Radio' },
  { preset: 'megaphone', name: 'Megaphone' },
  { preset: 'robot', name: 'Robot' },
  { preset: 'monster', name: 'Monster' },
  { preset: 'chipmunk', name: 'Chipmunk' },
];
const nameOf = (kind: EffectKind): string =>
  KINDS.find((entry) => entry.kind === kind)?.name ?? kind;

/** Starting points for the equalizer, from the cleanup a dialogue editor does first. */
const EQ_PRESETS: readonly { name: string; bands: EqBand[] }[] = [
  {
    name: 'Dialogue',
    bands: [
      EqBand.parse({ type: 'highpass', frequency: 90 }),
      EqBand.parse({ type: 'bell', frequency: 350, gainDb: -3, q: 1.2 }),
      EqBand.parse({ type: 'bell', frequency: 3200, gainDb: 2, q: 1 }),
    ],
  },
  { name: 'Rumble', bands: [EqBand.parse({ type: 'highpass', frequency: 80 })] },
  { name: 'Hiss', bands: [EqBand.parse({ type: 'lowpass', frequency: 9000 })] },
];

/** The equalizer's curve, on a log frequency axis from 20 Hz to 20 kHz. */
function EqCurve({ bands }: { bands: readonly EqBand[] }): ReactElement {
  const width = 280;
  const height = 72;
  const range = 18;
  const designs = bands.map((band) => designBiquad(band, 48_000));
  const x = (frequency: number): number => (Math.log10(frequency / 20) / 3) * width;
  const y = (db: number): number =>
    height / 2 - (Math.max(-range, Math.min(range, db)) / range) * (height / 2 - 4);
  const points: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const frequency = 20 * 10 ** ((3 * i) / 120);
    const db = designs.reduce((sum, design) => sum + responseDb(design, frequency, 48_000), 0);
    points.push(`${x(frequency).toFixed(1)},${y(db).toFixed(1)}`);
  }
  return (
    <svg
      className="eq-curve"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label="EQ curve"
      preserveAspectRatio="none"
    >
      {[100, 1000, 10_000].map((frequency) => (
        <line
          key={frequency}
          className="grid"
          x1={x(frequency)}
          x2={x(frequency)}
          y1={0}
          y2={height}
        />
      ))}
      <line className="grid zero" x1={0} x2={width} y1={height / 2} y2={height / 2} />
      <polyline className="curve" points={points.join(' ')} />
      {bands.map((band, index) => (
        <circle
          key={index}
          className="band-dot"
          cx={x(band.frequency)}
          cy={y(
            designs.reduce((sum, design) => sum + responseDb(design, band.frequency, 48_000), 0),
          )}
          r={3.5}
        />
      ))}
    </svg>
  );
}

function BandRow({
  band,
  onChange,
  onRemove,
}: {
  band: EqBand;
  onChange: (band: EqBand) => void;
  onRemove: (() => void) | undefined;
}): ReactElement {
  const id = useId();
  const pass = band.type === 'highpass' || band.type === 'lowpass';
  return (
    <div className="band">
      <div className="knob">
        <label htmlFor={id}>Band</label>
        <select
          id={id}
          className="input"
          value={band.type}
          onChange={(event) => {
            onChange({ ...band, type: EqBand.shape.type.parse(event.target.value) });
          }}
        >
          <option value="highpass">High-pass</option>
          <option value="lowshelf">Low shelf</option>
          <option value="bell">Bell</option>
          <option value="highshelf">High shelf</option>
          <option value="lowpass">Low-pass</option>
        </select>
      </div>
      <NumberInput
        label="Frequency"
        unit="Hz"
        value={band.frequency}
        step={10}
        min={20}
        max={20_000}
        onCommit={(frequency) => {
          onChange({ ...band, frequency });
        }}
      />
      {!pass && (
        <NumberInput
          label="Gain"
          unit="dB"
          value={band.gainDb}
          step={0.5}
          min={-24}
          max={24}
          onCommit={(gainDb) => {
            onChange({ ...band, gainDb });
          }}
        />
      )}
      <NumberInput
        label="Q"
        value={band.q}
        step={0.1}
        min={0.1}
        max={18}
        onCommit={(q) => {
          onChange({ ...band, q });
        }}
      />
      {onRemove !== undefined && (
        <button
          type="button"
          className="icon-button fx-remove"
          aria-label="Remove band"
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The settings of one effect, laid out for its kind. */
function Settings({
  effect,
  onChange,
}: {
  effect: Effect;
  onChange: (effect: Effect) => void;
}): ReactElement {
  const knob = (
    label: string,
    key: string,
    value: number,
    step: number,
    min: number,
    max: number,
    unit?: string,
  ): ReactElement => (
    <NumberInput
      key={key}
      label={label}
      value={value}
      step={step}
      min={min}
      max={max}
      {...(unit === undefined ? {} : { unit })}
      onCommit={(next) => {
        onChange(Effect.parse({ ...effect, [key]: next }));
      }}
    />
  );
  switch (effect.kind) {
    case 'eq':
      return (
        <div className="stack tight">
          <EqCurve bands={effect.bands} />
          <div className="row wrap fx-presets" role="group" aria-label="EQ presets">
            {EQ_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="chip"
                onClick={() => {
                  onChange({ ...effect, bands: preset.bands });
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
          {effect.bands.map((band, index) => (
            <BandRow
              key={index}
              band={band}
              onChange={(next) => {
                onChange({
                  ...effect,
                  bands: effect.bands.map((b, i) => (i === index ? next : b)),
                });
              }}
              onRemove={
                effect.bands.length > 1
                  ? () => {
                      onChange({ ...effect, bands: effect.bands.filter((_, i) => i !== index) });
                    }
                  : undefined
              }
            />
          ))}
          {effect.bands.length < 8 && (
            <button
              type="button"
              className="button small quiet"
              onClick={() => {
                onChange({
                  ...effect,
                  bands: [...effect.bands, EqBand.parse({ type: 'bell', frequency: 1000 })],
                });
              }}
            >
              <PlusIcon aria-hidden="true" /> Band
            </button>
          )}
        </div>
      );
    case 'compressor':
      return (
        <div className="knobs">
          {knob('Threshold', 'thresholdDb', effect.thresholdDb, 1, -60, 0, 'dB')}
          {knob('Ratio', 'ratio', effect.ratio, 0.5, 1, 20, ':1')}
          {knob('Attack', 'attackMs', effect.attackMs, 1, 0.1, 200, 'ms')}
          {knob('Release', 'releaseMs', effect.releaseMs, 10, 10, 2000, 'ms')}
          {knob('Knee', 'kneeDb', effect.kneeDb, 1, 0, 24, 'dB')}
          {knob('Makeup', 'makeupDb', effect.makeupDb, 0.5, 0, 24, 'dB')}
        </div>
      );
    case 'limiter':
      return (
        <div className="knobs">
          {knob('Ceiling', 'ceilingDb', effect.ceilingDb, 0.1, -24, 0, 'dB')}
          {knob('Release', 'releaseMs', effect.releaseMs, 5, 1, 1000, 'ms')}
        </div>
      );
    case 'denoise':
      return (
        <div className="knobs">
          {knob('Reduction', 'reductionDb', effect.reductionDb, 1, 0, 48, 'dB')}
          {knob('Sensitivity', 'sensitivityDb', effect.sensitivityDb, 0.5, 0, 24, 'dB')}
        </div>
      );
    case 'loudness':
      return (
        <div className="stack tight">
          <div className="row wrap fx-presets" role="group" aria-label="Loudness targets">
            {[
              { name: 'Broadcast −23', lufs: -23 },
              { name: 'Online −16', lufs: -16 },
              { name: 'Streaming −14', lufs: -14 },
            ].map((target) => (
              <button
                key={target.lufs}
                type="button"
                className="chip"
                aria-pressed={effect.targetLufs === target.lufs}
                onClick={() => {
                  onChange({ ...effect, targetLufs: target.lufs });
                }}
              >
                {target.name}
              </button>
            ))}
          </div>
          <div className="knobs">
            {knob('Target', 'targetLufs', effect.targetLufs, 0.5, -40, -5, 'LUFS')}
            {knob('True peak', 'truePeakDb', effect.truePeakDb, 0.1, -9, 0, 'dBTP')}
          </div>
        </div>
      );
    case 'distortion':
      return (
        <div className="stack tight">
          <span className="segmented" role="group" aria-label="Distortion shape">
            {(['soft', 'hard', 'fold'] as const).map((shape) => (
              <button
                key={shape}
                type="button"
                aria-pressed={effect.shape === shape}
                onClick={() => {
                  onChange({ ...effect, shape });
                }}
              >
                {shape === 'soft' ? 'Soft' : shape === 'hard' ? 'Hard' : 'Fold'}
              </button>
            ))}
          </span>
          <div className="knobs">
            {knob('Drive', 'driveDb', effect.driveDb, 1, 0, 48, 'dB')}
            {knob('Tone', 'toneHz', effect.toneHz, 100, 500, 20_000, 'Hz')}
            {knob('Mix', 'mix', effect.mix, 0.05, 0, 1)}
            {knob('Output', 'outputDb', effect.outputDb, 0.5, -24, 12, 'dB')}
          </div>
        </div>
      );
    case 'pitch':
      return (
        <div className="knobs">
          {knob('Semitones', 'semitones', effect.semitones, 0.5, -12, 12)}
        </div>
      );
    case 'ringmod':
      return (
        <div className="knobs">
          {knob('Frequency', 'frequency', effect.frequency, 5, 1, 2000, 'Hz')}
          {knob('Mix', 'mix', effect.mix, 0.05, 0, 1)}
        </div>
      );
    case 'crush':
      return (
        <div className="knobs">
          {knob('Bits', 'bits', effect.bits, 1, 2, 16)}
          {knob('Every', 'downsample', effect.downsample, 1, 1, 32, 'samples')}
        </div>
      );
  }
}

const show = (value: number | null, digits = 1): string =>
  value === null ? '−∞' : value.toFixed(digits).replace('-', '−');

/**
 * A region's effects as cards, in the order they run. Every change is one
 * command, so it can be undone, and the processed sound is ready when it
 * returns.
 */
export function EffectsPanel({
  regionId,
  effects,
  stretch,
  edit,
}: {
  regionId: string;
  effects: readonly Effect[];
  /** A selected stretch inside the region, to learn noise from. */
  stretch: { from: number; to: number } | null;
  edit: Edit;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [measured, setMeasured] = useState<{
    key: string;
    report: z.infer<typeof Report>;
  } | null>(null);
  // Measured again whenever the region or its chain changes.
  const measureKey = `${regionId} ${JSON.stringify(effects)}`;
  const report = measured?.key === measureKey ? measured.report : null;

  useEffect(() => {
    let active = true;
    void edit('audio.analyze', { regionId }).then((output) => {
      if (!active || output === undefined) return;
      const parsed = Report.safeParse(output);
      if (parsed.success) setMeasured({ key: measureKey, report: parsed.data });
    });
    return () => {
      active = false;
    };
  }, [edit, regionId, measureKey]);

  const run = async (id: string, input: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      await edit(id, input);
    } finally {
      setBusy(false);
    }
  };
  const setChain = (chain: readonly Effect[]): void => {
    void run('audio.fx.set', { regionIds: [regionId], effects: chain });
  };
  const add = (kind: EffectKind): void => {
    if (kind === 'denoise') {
      if (stretch === null) return;
      void run('audio.fx.denoise', {
        regionId,
        noiseFromSeconds: stretch.from,
        noiseToSeconds: stretch.to,
      });
      return;
    }
    const fresh =
      kind === 'eq'
        ? Effect.parse({ kind, bands: EQ_PRESETS[0]?.bands ?? [] })
        : Effect.parse({ kind });
    setChain([...effects, fresh]);
  };
  const present = new Set(effects.map((effect) => effect.kind));
  const denoise = effects.find((effect) => effect.kind === 'denoise');

  return (
    <section className="stack fx-panel" aria-label="Effects" aria-busy={busy}>
      <div className="fx-top">
        <p className="eyebrow">Effects</p>
        <p className="muted mono small fx-meter" aria-live="polite">
          {report === null
            ? 'Measuring…'
            : `${show(report.integratedLufs)} LUFS · ${show(report.truePeakDb)} dBTP`}
        </p>
      </div>
      {effects.length === 0 && (
        <p className="muted small">
          None yet. They run in order, on the whole sound of the region.
        </p>
      )}
      <ol className="fx-cards">
        {effects.map((effect, index) => (
          <li key={effect.kind} className="fx-card" data-kind={effect.kind}>
            <div className="fx-head">
              <span className="fx-index mono">{index + 1}</span>
              <span className="fx-name">{nameOf(effect.kind)}</span>
              <span className="fx-actions">
                {index > 0 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Run ${nameOf(effect.kind)} earlier`}
                    disabled={busy}
                    onClick={() => {
                      const next = effects.flatMap((existing, i) =>
                        i === index - 1 ? [effect, existing] : i === index ? [] : [existing],
                      );
                      setChain(next);
                    }}
                  >
                    <ArrowUpIcon aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${nameOf(effect.kind)}`}
                  disabled={busy}
                  onClick={() => {
                    setChain(effects.filter((_, i) => i !== index));
                  }}
                >
                  <XIcon aria-hidden="true" />
                </button>
              </span>
            </div>
            <p className="muted small fx-summary">{describeEffect(effect)}</p>
            <Settings
              effect={effect}
              onChange={(next) => {
                setChain(effects.map((existing, i) => (i === index ? next : existing)));
              }}
            />
            {effect.kind === 'denoise' && stretch !== null && (
              <button
                type="button"
                className="button small quiet"
                disabled={busy}
                onClick={() => {
                  add('denoise');
                }}
              >
                Learn the noise again from the selection
              </button>
            )}
          </li>
        ))}
      </ol>
      {(['clean', 'voice'] as const).map((group) => (
        <div key={group} className="stack tight">
          <p className="fx-group">{group === 'clean' ? 'Clean up' : 'Change the voice'}</p>
          {group === 'voice' && (
            <div className="row wrap fx-presets" role="group" aria-label="Ready-made voices">
              {VOICES.map((entry) => (
                <button
                  key={entry.preset}
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => {
                    void run('audio.fx.voice', { regionIds: [regionId], preset: entry.preset });
                  }}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          )}
          <div
            className="fx-add"
            role="group"
            aria-label={group === 'clean' ? 'Add a clean-up effect' : 'Add a voice effect'}
          >
            {KINDS.filter((entry) => entry.group === group && !present.has(entry.kind)).map(
              (entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  className="fx-add-button"
                  disabled={busy || (entry.kind === 'denoise' && stretch === null)}
                  onClick={() => {
                    add(entry.kind);
                  }}
                >
                  <PlusIcon aria-hidden="true" />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.hint}</small>
                  </span>
                </button>
              ),
            )}
          </div>
        </div>
      ))}
      {denoise === undefined && stretch === null && (
        <p className="muted small">
          For noise reduction, drag across a stretch of this region where only the noise is heard.
        </p>
      )}
    </section>
  );
}
