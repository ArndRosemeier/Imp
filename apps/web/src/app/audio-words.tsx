import { TRANSCRIPTION_MODEL_SETTING, wordSpan } from '@imp/audio';
import type { Project } from '@imp/core';
import type { ImpClient } from '@imp/host';
import {
  ArrowsClockwiseIcon,
  PlayIcon,
  SpeakerSlashIcon,
  TextTIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Fragment, useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand } from './context.js';
import { ModelPicker, useModelSetting, type Act } from './movie.js';
import { Price } from './spend.js';

const Word = z.object({
  index: z.number(),
  text: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
});
const RegionText = z.object({
  trackId: z.string(),
  regionId: z.string(),
  label: z.string(),
  transcribed: z.boolean(),
  text: z.string(),
  words: z.array(Word),
});
type RegionText = z.infer<typeof RegionText>;
const Texts = z.object({ regions: z.array(RegionText) });
const Written = z.object({ costUsd: z.number().nullable(), written: z.number() });

/** Words picked in one region, by their numbers there. */
interface Picked {
  readonly regionId: string;
  readonly anchor: number;
  readonly from: number;
  readonly to: number;
}

interface PanelRegion {
  readonly id: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * Dialogue as text. Each region shows what it says, word by word; picking
 * words selects their stretch on the timeline, so Delete, cut, copy and paste
 * work on words as they do on time. Words are cut in the pauses around them.
 */
export function WordsPanel({
  imp,
  project,
  docId,
  revision,
  regions,
  trackNames,
  at,
  playing,
  act,
  onSelect,
  onPlay,
}: {
  imp: ImpClient;
  project: Project;
  docId: string;
  /** Changes whenever the document does, to read the words again. */
  revision: string;
  regions: readonly PanelRegion[];
  trackNames: ReadonlyMap<string, string>;
  at: number;
  playing: boolean;
  act: Act;
  /** Selects a stretch of one track on the timeline and moves the playhead to its start. */
  onSelect: (selection: { trackId: string; from: number; to: number } | null) => void;
  onPlay: (from: number, to: number) => void;
}): ReactElement {
  const model = useModelSetting(TRANSCRIPTION_MODEL_SETTING, 'transcription');
  const [texts, setTexts] = useState<readonly RegionText[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [read, setRead] = useState(0);
  const [sweeping, setSweeping] = useState(false);
  const pressed = useRef(false);

  useEffect(() => {
    let active = true;
    runCommand(imp, 'audio.transcript.get', { projectId: project.id, docId }).then(
      (output) => {
        if (active) setTexts(Texts.parse(output).regions);
      },
      (reason: unknown) => {
        if (active) setError(messageOf(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [imp, project.id, docId, revision, read]);

  const bounds = new Map(regions.map((region) => [region.id, region]));
  const shown = (texts ?? []).filter((text) => bounds.has(text.regionId));
  const missing = shown.filter((text) => !text.transcribed).length;
  const pickedText = shown.find((text) => text.regionId === picked?.regionId);
  // An edit renumbers words: what was picked is gone.
  const current = pickedText === undefined ? null : picked;

  const spanOf = (choice: Picked): { trackId: string; from: number; to: number } | null => {
    const text = shown.find((candidate) => candidate.regionId === choice.regionId);
    const region = bounds.get(choice.regionId);
    if (text === undefined || region === undefined) return null;
    const span = wordSpan(text.words, choice.from, choice.to, region);
    return { trackId: text.trackId, from: span.fromSeconds, to: span.toSeconds };
  };

  const choose = (choice: Picked | null): void => {
    setPicked(choice);
    onSelect(choice === null ? null : spanOf(choice));
  };

  /** A tap picks a word; a tap on another word of the same region stretches the pick to it. */
  const tap = (text: RegionText, index: number): void => {
    if (current?.regionId !== text.regionId) {
      choose({ regionId: text.regionId, anchor: index, from: index, to: index });
      return;
    }
    if (index >= current.from && index <= current.to) {
      const single = current.from === current.to;
      choose(single ? null : { regionId: text.regionId, anchor: index, from: index, to: index });
      return;
    }
    choose({
      regionId: text.regionId,
      anchor: current.anchor,
      from: Math.min(current.anchor, index),
      to: Math.max(current.anchor, index),
    });
  };

  const wordAt = (x: number, y: number): { regionId: string; index: number } | null => {
    const element = document.elementFromPoint(x, y);
    const word =
      element instanceof HTMLElement ? element.closest<HTMLElement>('[data-word]') : null;
    if (word === null) return null;
    return { regionId: word.dataset['region'] ?? '', index: Number(word.dataset['word']) };
  };

  // A mouse or pen drags across words; fingers tap, so the page still scrolls under them.
  const onDown = (event: PointerEvent<HTMLButtonElement>, text: RegionText, index: number) => {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    pressed.current = true;
    setSweeping(true);
    if (event.shiftKey && current?.regionId === text.regionId) {
      choose({
        ...current,
        from: Math.min(current.anchor, index),
        to: Math.max(current.anchor, index),
      });
      return;
    }
    choose({ regionId: text.regionId, anchor: index, from: index, to: index });
  };
  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!sweeping || current === null) return;
    const hit = wordAt(event.clientX, event.clientY);
    if (hit?.regionId !== current.regionId) return;
    const from = Math.min(current.anchor, hit.index);
    const to = Math.max(current.anchor, hit.index);
    if (from !== current.from || to !== current.to) choose({ ...current, from, to });
  };

  const write = async (): Promise<void> => {
    setError(null);
    setNote(null);
    setWriting(true);
    try {
      const done = Written.parse(
        await runCommand(imp, 'audio.transcribe', { projectId: project.id, docId }),
      );
      setNote(
        done.written === 0
          ? 'Everything here was written down already.'
          : `Written down${done.costUsd === null ? '' : ` for $${done.costUsd.toFixed(4)}`}.`,
      );
      setRead((value) => value + 1);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setWriting(false);
    }
  };

  const remove = async (keepTime: boolean): Promise<void> => {
    if (current === null) return;
    setError(null);
    const choice = current;
    choose(null);
    try {
      await runCommand(imp, 'audio.words.delete', {
        projectId: project.id,
        docId,
        regionId: choice.regionId,
        fromWord: choice.from,
        toWord: choice.to,
        keepTime,
      });
    } catch (reason) {
      setError(messageOf(reason));
    }
  };

  const span = current === null ? null : spanOf(current);
  const chosenText =
    current === null || pickedText === undefined
      ? ''
      : pickedText.words
          .slice(current.from, current.to + 1)
          .map((word) => word.text)
          .join(' ');

  return (
    <section className="words-panel" aria-label="Dialogue as text">
      <header className="words-head">
        <div>
          <p className="eyebrow">Words</p>
          <p className="muted small">
            Tap a word, then another to take in everything between (with a mouse, drag or
            Shift-click). The words are selected on the timeline too, so Ctrl+X and Ctrl+V move
            them.
          </p>
        </div>
        <div className="words-write">
          <ModelPicker
            id="transcription-model"
            label="Transcription model"
            empty="Choose a model that gives word times"
            setting={TRANSCRIPTION_MODEL_SETTING}
            choice={model}
            act={act}
          />
          <button
            type="button"
            className="button"
            disabled={writing || model.model === null || shown.length === 0}
            title={
              model.model === null
                ? 'Choose a transcription model first'
                : 'Costs a fraction of a cent a minute'
            }
            onClick={() => {
              void write();
            }}
          >
            {missing === 0 && shown.length > 0 ? (
              <ArrowsClockwiseIcon aria-hidden="true" />
            ) : (
              <TextTIcon aria-hidden="true" />
            )}
            {writing
              ? 'Listening…'
              : missing === 0 && shown.length > 0
                ? 'Check for new sound'
                : `Write down what is said${missing > 1 ? ` (${String(missing)} regions)` : ''}`}
            {!writing && missing > 0 && (
              <Price command="audio.transcribe" input={{ projectId: project.id, docId }} />
            )}
          </button>
        </div>
      </header>
      {error !== null && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {note !== null && error === null && <p className="muted small">{note}</p>}

      {current !== null && span !== null && (
        <div className="words-actions" role="toolbar" aria-label="Picked words">
          <span className="words-chosen">“{chosenText}”</span>
          <button
            type="button"
            className="button small"
            onClick={() => {
              onPlay(span.from, span.to);
            }}
          >
            <PlayIcon aria-hidden="true" weight="fill" /> Play
          </button>
          <button
            type="button"
            className="button small"
            title="Removes the words and closes the gap"
            onClick={() => {
              void remove(false);
            }}
          >
            <TrashIcon aria-hidden="true" /> Delete
          </button>
          <button
            type="button"
            className="button small"
            title="Removes the words and leaves the pause, so nothing moves"
            onClick={() => {
              void remove(true);
            }}
          >
            <SpeakerSlashIcon aria-hidden="true" /> Silence
          </button>
        </div>
      )}

      {/* Pointer sweeps only; every word is a button for keyboards and taps. */}
      <div
        className="words-list"
        onPointerMove={onMove}
        onPointerUp={() => {
          setSweeping(false);
        }}
        onPointerLeave={() => {
          setSweeping(false);
        }}
      >
        {texts === null && <p className="muted small">Reading…</p>}
        {texts !== null && shown.length === 0 && (
          <p className="muted small">No sound on the tracks yet.</p>
        )}
        {shown.map((text) => {
          const region = bounds.get(text.regionId);
          return (
            <div key={text.regionId} className="words-region">
              <p className="words-label mono small">
                {trackNames.get(text.trackId) ?? ''}
                {text.label === '' ? '' : ` · ${text.label}`}
                {region === undefined ? '' : ` · ${region.startSeconds.toFixed(2)} s`}
              </p>
              {!text.transcribed && <p className="muted small">Not written down yet.</p>}
              {text.transcribed && text.words.length === 0 && (
                <p className="muted small">No words here.</p>
              )}
              <p className="words-line">
                {text.words.map((word) => {
                  const inPick =
                    current?.regionId === text.regionId &&
                    word.index >= current.from &&
                    word.index <= current.to;
                  const spoken = playing && at >= word.startSeconds && at < word.endSeconds;
                  return (
                    <Fragment key={word.index}>
                      <button
                        type="button"
                        className="word"
                        data-word={word.index}
                        data-region={text.regionId}
                        data-picked={inPick}
                        data-spoken={spoken}
                        // Some models note sounds that are not words, such as [laughs].
                        data-event={/^[[(].*[\])]$/.test(word.text)}
                        aria-pressed={inPick}
                        title={`${word.startSeconds.toFixed(2)} s`}
                        onPointerDown={(event) => {
                          onDown(event, text, word.index);
                        }}
                        onClick={() => {
                          // A mouse press already picked it; taps and keys pick here.
                          if (pressed.current) {
                            pressed.current = false;
                            return;
                          }
                          tap(text, word.index);
                        }}
                      >
                        {word.text}
                      </button>{' '}
                    </Fragment>
                  );
                })}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
