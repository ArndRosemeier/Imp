import type { Project } from '@imp/core';
import { ScriptNote } from '@imp/mode-movie';
import { CheckIcon, ArrowCounterClockwiseIcon, TrashIcon } from '@phosphor-icons/react';
import { useId, useState, type ReactElement, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { MARKER_KINDS, markerAuthor } from './markers.js';
import { Problem, useAct } from './movie.js';
import { t, tn } from '../i18n/i18n.js';

const NoteList = z.object({ notes: z.array(ScriptNote) });

/**
 * The notes on a scene from a read-through of the script: what a first reader
 * found while it is still words and a change costs nothing. Open ones first;
 * the done ones fold away. Anyone can leave one, and mark it done.
 */
export function ScriptNotes({
  project,
  sceneId,
}: {
  project: Project;
  sceneId: string;
}): ReactElement {
  const live = useLive([`projects/${project.id}/movie/script-notes/`], async (imp) =>
    NoteList.parse(
      await runCommand(imp, 'movie.script.note.list', { projectId: project.id, sceneId }),
    ),
  );
  const { act, error, retry } = useAct(project);
  const [kind, setKind] = useState<ScriptNote['kind']>('note');
  const [text, setText] = useState('');
  const [showDone, setShowDone] = useState(false);
  const textId = useId();
  const notes = live.data?.notes ?? [];
  const open = notes.filter((note) => note.status === 'open');
  const done = notes.filter((note) => note.status === 'done');

  const add = (event: SyntheticEvent): void => {
    event.preventDefault();
    const words = text.trim();
    if (words === '') return;
    void act('movie.script.note.add', { sceneId, kind, text: words }).then(() => {
      setText('');
    });
  };

  const row = (note: ScriptNote): ReactElement => (
    <li
      key={note.id}
      className={`script-note marker-${note.kind}${note.status === 'done' ? ' done' : ''}`}
    >
      <div className="stack tight">
        <span className="small muted">
          {MARKER_KINDS.find((choice) => choice.kind === note.kind)?.label ?? t('Note')} ·{' '}
          {t('by {by}', { by: markerAuthor(note.by) })}
        </span>
        {note.quote !== '' && <q className="script-note-quote">{note.quote}</q>}
        <span>{note.text}</span>
      </div>
      <div className="row">
        {note.status === 'open' ? (
          <button
            className="button small"
            onClick={() => {
              void act('movie.script.note.set', { noteId: note.id, status: 'done' });
            }}
          >
            <CheckIcon aria-hidden="true" /> {t('Done')}
          </button>
        ) : (
          <button
            className="button small quiet"
            onClick={() => {
              void act('movie.script.note.set', { noteId: note.id, status: 'open' });
            }}
          >
            <ArrowCounterClockwiseIcon aria-hidden="true" /> {t('Open again')}
          </button>
        )}
        <button
          className="button small quiet icon"
          aria-label={t('Remove note')}
          title={t('Remove note')}
          onClick={() => {
            void act('movie.script.note.remove', { noteId: note.id });
          }}
        >
          <TrashIcon aria-hidden="true" />
        </button>
      </div>
    </li>
  );

  return (
    <section className="stack script-notes" aria-label={t('Script notes')}>
      <div className="row spread wrap">
        <h3>{t('Notes')}</h3>
        <span className="muted small">
          {open.length === 0
            ? t('No open notes')
            : tn(open.length, '{count} open note', '{count} open notes')}
        </span>
      </div>
      <Problem text={live.error ?? error} retry={retry} />
      {open.length > 0 && <ul className="stack script-note-list">{open.map(row)}</ul>}
      {done.length > 0 && (
        <button
          className="button small quiet"
          aria-expanded={showDone}
          onClick={() => {
            setShowDone(!showDone);
          }}
        >
          {tn(done.length, '{count} done note', '{count} done notes')}
        </button>
      )}
      {showDone && done.length > 0 && <ul className="stack script-note-list">{done.map(row)}</ul>}
      <form className="row wrap script-note-add" onSubmit={add}>
        <span className="segmented" role="group" aria-label={t('Kind of note')}>
          {MARKER_KINDS.map((choice) => (
            <button
              key={choice.kind}
              type="button"
              aria-pressed={kind === choice.kind}
              onClick={() => {
                setKind(choice.kind);
              }}
            >
              {choice.label}
            </button>
          ))}
        </span>
        <label className="sr-only" htmlFor={textId}>
          {t('A note on this scene')}
        </label>
        <input
          id={textId}
          className="input grow"
          type="text"
          value={text}
          placeholder={t('A note on this scene')}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <button type="submit" className="button" disabled={text.trim() === ''}>
          {t('Add note')}
        </button>
      </form>
    </section>
  );
}
