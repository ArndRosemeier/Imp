import { MicrophoneIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import type { PointerEvent, ReactElement } from 'react';
import type { Cut, Line } from './cut-player.js';
import { EditableField } from './Field.js';
import type { Act } from './movie.js';
import { NumberField } from './NumberField.js';
import { Price } from './spend.js';
import { t } from '../i18n/i18n.js';

/** A piece must be at least this wide to be grabbed with a finger. */
const MIN_BLOCK_PX = 22;

/**
 * One lane for each character that has a lane of its own (a narrator, for
 * example), with the lines placed on it. Selecting a line shows it in the
 * inspector next to the preview.
 */
export function CharacterLanes({
  cut,
  scale,
  at,
  sceneId,
  selectedId,
  onSelect,
  act,
  marks,
  drag,
}: {
  cut: Cut;
  scale: number;
  at: number;
  sceneId: string;
  selectedId: string | null;
  onSelect: (lineId: string) => void;
  act: Act;
  /** Lines agents changed, by id, while their proposal is shown. */
  marks?: ReadonlyMap<string, string>;
  /** Pointer handlers that move a line sideways, and how far it is dragged now, in seconds. */
  drag: (
    line: Line,
    selected: boolean,
  ) => {
    dx: number;
    props: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
      onPointerCancel: () => void;
    };
  };
}): ReactElement {
  return (
    <>
      {cut.lanes.map((lane) => (
        <div
          key={lane.characterId}
          className="lane lane-voice"
          aria-label={t('{name} lane', { name: lane.name })}
        >
          <span className="lane-name">
            {lane.name}{' '}
            <button
              className="button quiet icon"
              aria-label={t('Add a line to {name} at the playhead', { name: lane.name })}
              title={t('Add a line to {name} at the playhead', { name: lane.name })}
              onClick={() => {
                void act('movie.edit.line.add', {
                  sceneId,
                  characterId: lane.characterId,
                  text: t('New line'),
                  startSeconds: Math.round(at * 10) / 10,
                }).then((added) => {
                  const id = (added as { id?: unknown } | undefined)?.id;
                  if (typeof id === 'string') onSelect(id);
                });
              }}
            >
              <PlusIcon aria-hidden="true" />
            </button>
          </span>
          {cut.lines
            .filter((line) => line.characterId === lane.characterId)
            .map((line) => {
              const { dx, props } = drag(line, selectedId === line.id);
              return (
                <div
                  {...props}
                  key={line.id}
                  className={`block block-dialogue${selectedId === line.id ? ' selected' : ''}${line.recorded ? '' : ' empty'}${marks?.has(line.id) === true ? ` tracked tracked-${marks.get(line.id) ?? ''}` : ''}`}
                  style={{
                    left: Math.max(0, line.startSeconds + dx) * scale,
                    width: Math.max(
                      MIN_BLOCK_PX,
                      Math.max(line.durationSeconds - line.trimStartSeconds, 0.5) * scale,
                    ),
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedId === line.id}
                  aria-label={`${lane.name}: ${line.text.slice(0, 40)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(line.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSelect(line.id);
                  }}
                >
                  <span className="block-label">{line.text}</span>
                </div>
              );
            })}
        </div>
      ))}
    </>
  );
}

/** The selected line: its words, when it is said, and the recording. */
export function LineInspector({
  line,
  who,
  url,
  sceneId,
  act,
  onGone,
}: {
  line: Line;
  who: string;
  url: string | undefined;
  sceneId: string;
  act: Act;
  onGone: () => void;
}): ReactElement {
  const change = (fields: Record<string, unknown>): Promise<unknown> =>
    act('movie.edit.line.update', { sceneId, lineId: line.id, ...fields });
  return (
    <>
      <h3>
        {who}{' '}
        <span className="muted">
          {line.recorded
            ? line.outdated
              ? t('recording is of earlier words')
              : t('recorded')
            : t('not recorded')}
        </span>
      </h3>
      <EditableField
        label={t('Words')}
        rows={3}
        value={line.text}
        onCommit={(text) => change({ text })}
      />
      <EditableField
        label={t('Delivery')}
        value={line.delivery}
        placeholder={t('How it is said: hushed, tired, amused.')}
        onCommit={(delivery) => change({ delivery })}
      />
      <div className="row wrap">
        <NumberField
          label={t('Starts at (s)')}
          value={line.startSeconds}
          step={0.5}
          max={36000}
          onCommit={(startSeconds) => {
            void change({ startSeconds });
          }}
        />
        <NumberField
          label={t('Volume (0 to 1)')}
          value={line.volume}
          step={0.1}
          max={1}
          onCommit={(volume) => {
            void change({ volume });
          }}
        />
        <NumberField
          label={t('Fade in (s)')}
          value={line.fadeInSeconds}
          step={0.1}
          max={60}
          onCommit={(fadeInSeconds) => {
            void change({ fadeInSeconds });
          }}
        />
        <NumberField
          label={t('Fade out (s)')}
          value={line.fadeOutSeconds}
          step={0.1}
          max={60}
          onCommit={(fadeOutSeconds) => {
            void change({ fadeOutSeconds });
          }}
        />
      </div>
      {/* The words are in the field above; a recording has no caption track. */}
      {url !== undefined && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls src={url} aria-label={t('Recording of {who}', { who })} />
      )}
      <div className="row wrap">
        <button
          className="button"
          onClick={() => {
            void act('movie.edit.line.record', { sceneId, lineId: line.id });
          }}
          title={t('Speaks the line in the voice of the character. Costs a cent or less.')}
        >
          <MicrophoneIcon aria-hidden="true" /> {line.recorded ? t('Record again') : t('Record')}
          <Price command="movie.edit.line.record" input={{ sceneId, lineId: line.id }} />
        </button>
        <button
          className="button quiet"
          onClick={() => {
            void act('movie.edit.line.remove', { sceneId, lineId: line.id }).then(onGone);
          }}
        >
          <TrashIcon aria-hidden="true" /> {t('Remove line')}
        </button>
      </div>
    </>
  );
}
