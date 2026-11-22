import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { t } from '../i18n/i18n.js';

type Run = (id: string, input: Record<string, unknown>) => Promise<unknown>;

export const MarkerView = z.object({
  id: z.string(),
  sceneId: z.string(),
  atSeconds: z.number(),
  filmSeconds: z.number(),
  text: z.string(),
  kind: z.enum(['note', 'todo', 'problem']),
  done: z.boolean(),
  by: z.string(),
});
export type MarkerView = z.infer<typeof MarkerView>;
export const MarkerList = z.object({ markers: z.array(MarkerView) });

export const MARKER_KINDS: readonly { kind: MarkerView['kind']; label: string }[] = [
  {
    kind: 'note',
    get label(): string {
      return t('Note');
    },
  },
  {
    kind: 'todo',
    get label(): string {
      return t('To do');
    },
  },
  {
    kind: 'problem',
    get label(): string {
      return t('Problem');
    },
  },
];

/** Who left a marker, in words: you, or the crew member's role. */
export function markerAuthor(by: string): string {
  if (by === 'person') return t('You');
  const words = by.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The markers of a scene above its timeline: a flag at each, coloured by
 * kind, faded once done. A tap selects one for the inspector and moves the
 * playhead to it.
 */
export function MarkerLane({
  markers,
  scale,
  selectedId,
  onSelect,
}: {
  markers: readonly MarkerView[];
  scale: number;
  selectedId: string | null;
  onSelect: (marker: MarkerView) => void;
}): ReactElement {
  return (
    <div className="lane lane-markers" aria-label={t('Markers')}>
      <span className="lane-name">{t('Markers')}</span>
      {markers.map((marker) => (
        <button
          key={marker.id}
          className={`marker-flag marker-${marker.kind}${marker.done ? ' done' : ''}${marker.id === selectedId ? ' selected' : ''}`}
          style={{ left: marker.atSeconds * scale }}
          aria-pressed={marker.id === selectedId}
          aria-label={`${MARKER_KINDS.find((kind) => kind.kind === marker.kind)?.label ?? t('Note')}${marker.done ? `, ${t('done')}` : ''}: ${marker.text}`}
          title={`${marker.text} (${markerAuthor(marker.by)})`}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(marker);
          }}
        >
          <span className="marker-flag-text">{marker.text}</span>
        </button>
      ))}
    </div>
  );
}

/** A marker in the inspector: its words, kind and whether it is done, moved or taken off. */
export function MarkerInspector({
  marker,
  playheadSeconds,
  run,
  onRemoved,
}: {
  marker: MarkerView;
  playheadSeconds: number;
  run: Run;
  onRemoved: () => void;
}): ReactElement {
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? marker.text;
  const set = (fields: Record<string, unknown>): void => {
    void run('movie.edit.marker.set', { markerId: marker.id, ...fields });
  };
  return (
    <section className="stack marker-inspector" aria-label={t('Marker')}>
      <div className="row spread wrap">
        <h4>{t('Marker')}</h4>
        <span className="muted small">{t('by {by}', { by: markerAuthor(marker.by) })}</span>
      </div>
      <span className="segmented" role="group" aria-label={t('Kind of marker')}>
        {MARKER_KINDS.map((choice) => (
          <button
            key={choice.kind}
            aria-pressed={marker.kind === choice.kind}
            onClick={() => {
              set({ kind: choice.kind });
            }}
          >
            {choice.label}
          </button>
        ))}
      </span>
      <label className="field compact">
        <span>{t('What it says')}</span>
        <textarea
          className="input"
          rows={3}
          value={text}
          maxLength={1000}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onBlur={() => {
            setTyped(null);
            const words = text.trim();
            if (words !== '' && words !== marker.text) set({ text: words });
          }}
        />
      </label>
      <div className="row wrap">
        <label className="row">
          <input
            type="checkbox"
            checked={marker.done}
            onChange={(event) => {
              set({ done: event.target.checked });
            }}
          />
          <span>{t('Done')}</span>
        </label>
        <button
          className="button small"
          onClick={() => {
            set({ atSeconds: Math.round(playheadSeconds * 1000) / 1000 });
          }}
        >
          {t('Move to playhead')}
        </button>
        <button
          className="button small quiet"
          onClick={() => {
            void run('movie.edit.marker.remove', { markerId: marker.id }).then(onRemoved);
          }}
        >
          {t('Remove')}
        </button>
      </div>
    </section>
  );
}
