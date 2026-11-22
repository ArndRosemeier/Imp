import type { Project } from '@imp/core';
import {
  parseFountain,
  parseMarkup,
  ScriptLineView,
  UnscriptedLine,
  type ScriptElement,
  type ScriptElementType,
} from '@imp/mode-movie';
import {
  ArticleIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  PencilSimpleLineIcon,
  PlusIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react';
import { useRef, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { runCommand, useImp, useLive, type Live } from './context.js';
import { moviePrefix, type Act } from './movie.js';
import { saveFile } from './projects.js';

/**
 * The script as a screenplay: a page set the way scripts are set, and a
 * writing view in Fountain with keys and buttons for the parts of a
 * screenplay, so that a scene can be written on a tablet as easily as with a
 * keyboard. The words are stored as Fountain text, which agents write too.
 */

/** Words with their emphasis marks shown as emphasis. */
export function RichWords({ text }: { text: string }): ReactElement {
  return (
    <>
      {parseMarkup(text).map((run, index) => {
        const style = {
          ...(run.bold ? { fontWeight: 700 } : {}),
          ...(run.italic ? { fontStyle: 'italic' as const } : {}),
          ...(run.underline ? { textDecoration: 'underline' } : {}),
        };
        return Object.keys(style).length === 0 ? (
          <span key={index}>{run.text}</span>
        ) : (
          <span key={index} style={style}>
            {run.text}
          </span>
        );
      })}
    </>
  );
}

const Lines = z.object({ lines: z.array(ScriptLineView), unscripted: z.array(UnscriptedLine) });

/** A scene's spoken lines and the shots that speak them, live. */
export function useScriptLines(
  project: Project,
  sceneId: string | undefined,
): Live<z.infer<typeof Lines>> {
  // The scene's own key names the scene, so that another scene loads its own lines.
  return useLive(
    [moviePrefix(project), `${moviePrefix(project)}scenes/${sceneId ?? ''}`],
    async (imp) =>
      sceneId === undefined
        ? { lines: [], unscripted: [] }
        : Lines.parse(
            await runCommand(imp, 'movie.script.lines', { projectId: project.id, sceneId }),
          ),
  );
}

/** Which spoken line each dialogue element belongs to, counted as movie.script.lines counts them. */
function lineIndexes(elements: readonly ScriptElement[]): Map<number, number> {
  const indexes = new Map<number, number>();
  let line = -1;
  let speaking = false;
  let counted = false;
  for (const [at, element] of elements.entries()) {
    if (element.type === 'character') {
      speaking = true;
      counted = false;
    } else if (element.type === 'dialogue' && speaking) {
      if (!counted) {
        line += 1;
        counted = true;
      }
      indexes.set(at, line);
    } else if (element.type !== 'parenthetical' && element.type !== 'note') {
      speaking = false;
    }
  }
  return indexes;
}

/**
 * The elements as they sit on the page: one at a time, except dual dialogue,
 * where a speech and the one marked ^ after it go side by side.
 */
function groupDual(
  elements: readonly ScriptElement[],
): (number | [readonly number[], readonly number[]])[] {
  const speechFrom = (from: number): number[] => {
    const picked: number[] = [];
    for (let at = from; at < elements.length; at += 1) {
      const type = elements[at]?.type;
      if (
        at === from
          ? type !== 'character'
          : type !== 'parenthetical' && type !== 'dialogue' && type !== 'lyric'
      )
        break;
      picked.push(at);
    }
    return picked;
  };
  const groups: (number | [readonly number[], readonly number[]])[] = [];
  for (let at = 0; at < elements.length; at += 1) {
    const first = speechFrom(at);
    const next = elements[at + first.length];
    if (first.length > 0 && next?.type === 'character' && next.dual === true) {
      const second = speechFrom(at + first.length);
      groups.push([first, second]);
      at += first.length + second.length - 1;
    } else {
      groups.push(at);
    }
  }
  return groups;
}

/** The scene set as a screenplay page, with the shots that speak each line in the margin. */
export function ScreenplayPage({
  heading,
  body,
  lines,
  shotNumbers,
  onWrite,
}: {
  heading: string;
  body: string;
  lines: readonly ScriptLineView[];
  /** A shot's number in its scene, by id. */
  shotNumbers: ReadonlyMap<string, number>;
  onWrite?: () => void;
}): ReactElement {
  const elements = parseFountain(body);
  const indexes = lineIndexes(elements);
  const renderAt = (at: number): ReactElement | null => {
    const element = elements[at];
    if (element === undefined) return null;
    if (element.type === 'page-break') return <hr key={at} className="sp-break" />;
    const index = indexes.get(at);
    const line = index === undefined ? undefined : lines[index];
    const shots = line?.shotIds.flatMap((id) => {
      const number = shotNumbers.get(id);
      return number === undefined ? [] : [number];
    });
    const text =
      element.type === 'character' || element.type === 'transition'
        ? element.text.toUpperCase()
        : element.text;
    return (
      <p key={at} className={`sp sp-${element.type}${element.dual === true ? ' sp-dual' : ''}`}>
        {element.type === 'section' && (
          <span className="sp-mark">{'#'.repeat(element.depth ?? 1)} </span>
        )}
        <RichWords text={text} />
        {shots !== undefined && line !== undefined && (
          <span
            className={`sp-shots${shots.length === 0 ? ' none' : ''}`}
            title={
              shots.length === 0
                ? 'No shot speaks this line yet'
                : `Spoken in shot ${shots.join(', ')}`
            }
          >
            {shots.length === 0 ? (
              'no shot'
            ) : (
              <>
                <FilmSlateIcon aria-hidden="true" /> {shots.join(', ')}
              </>
            )}
          </span>
        )}
      </p>
    );
  };
  return (
    // A tap on the page opens it for writing, as a tap on paper would.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="screenplay" onClick={onWrite}>
      <div className="screenplay-page" aria-label="The scene as a screenplay page">
        {heading.trim() !== '' && <p className="sp sp-heading">{heading.toUpperCase()}</p>}
        {elements.length === 0 && (
          <p className="sp sp-empty">Nothing written yet. Tap to write the scene.</p>
        )}
        {groupDual(elements).map((group) => {
          if (typeof group === 'number') return renderAt(group);
          return (
            <div key={group[0][0]} className="sp-dual-pair">
              {group.map((side, column) => (
                <div key={column} className="sp-dual-side">
                  {side.map(renderAt)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What part of a screenplay a line of Fountain text is, judged from it and its neighbours. */
export function lineType(lines: readonly string[], at: number): ScriptElementType {
  const line = (lines[at] ?? '').trim();
  const before = (lines[at - 1] ?? '').trim();
  const after = (lines[at + 1] ?? '').trim();
  if (line === '') return 'action';
  if (line.startsWith('(') && line.endsWith(')') && before !== '') return 'parenthetical';
  if (
    line.startsWith('>') ||
    (line !== '' && line === line.toUpperCase() && line.endsWith('TO:'))
  ) {
    return 'transition';
  }
  if (before !== '' && at > 0) {
    const above = lineType(lines, at - 1);
    if (above === 'character' || above === 'parenthetical' || above === 'dialogue')
      return 'dialogue';
  }
  const name = line.replace(/\s*\^$/, '').replace(/\s*\([^)]*\)\s*$/, '');
  if (
    before === '' &&
    after !== '' &&
    ((line.startsWith('@') && line.length > 1) ||
      (/\p{Lu}/u.test(name) && name === name.toUpperCase() && !line.startsWith('!')))
  ) {
    return 'character';
  }
  return 'action';
}

/** The parts the writing keys and buttons go through, in order. */
const CYCLE: readonly ScriptElementType[] = [
  'action',
  'character',
  'parenthetical',
  'dialogue',
  'transition',
];

const BARE = (line: string): string =>
  line
    .trim()
    .replace(/^[!@>.]\s*/, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\s*<$/, '');

/**
 * Makes the line at a place into a part of a screenplay, as Fountain writes
 * it: a name in capitals after a blank line, a direction in brackets, speech
 * right under the name, a transition in capitals. Returns the new text and
 * where the caret goes (the end of the line).
 */
export function makeLine(
  text: string,
  caret: number,
  type: ScriptElementType,
): { text: string; caret: number } {
  const lines = text.split('\n');
  let at = text.slice(0, caret).split('\n').length - 1;
  const bare = BARE(lines[at] ?? '');
  let line = bare;
  if (type === 'character') line = bare.toUpperCase();
  if (type === 'parenthetical') line = `(${bare})`;
  if (type === 'transition')
    line = /:$|\.$/.test(bare) ? bare.toUpperCase() : `${bare.toUpperCase()} TO:`;
  if (type === 'action' && bare !== '' && bare === bare.toUpperCase() && /\p{Lu}/u.test(bare)) {
    line = `!${bare}`;
  }
  lines[at] = line;
  const needsGap = type === 'character' || type === 'transition' || type === 'action';
  const joins = type === 'dialogue' || type === 'parenthetical';
  if (needsGap && at > 0 && (lines[at - 1] ?? '').trim() !== '') {
    lines.splice(at, 0, '');
    at += 1;
  }
  if (joins) {
    while (at > 0 && (lines[at - 1] ?? '').trim() === '' && at - 1 > 0) {
      lines.splice(at - 1, 1);
      at -= 1;
    }
  }
  if (type === 'transition' && at < lines.length - 1 && (lines[at + 1] ?? '').trim() !== '') {
    lines.splice(at + 1, 0, '');
  }
  const next = lines.join('\n');
  const end = lines.slice(0, at + 1).join('\n').length;
  return { text: next, caret: end };
}

const TYPE_NAMES: Partial<Record<ScriptElementType, string>> = {
  action: 'Action',
  character: 'Character',
  parenthetical: 'Direction',
  dialogue: 'Dialogue',
  transition: 'Transition',
};

/**
 * A scene's text in Fountain, with buttons and keys for the parts of a
 * screenplay. Tab turns the line into the next part (Shift+Tab the one
 * before); Enter after a line of speech starts the next block. The cast's
 * names are a tap away.
 */
export function ScreenplayWriter({
  value,
  cast,
  onCommit,
}: {
  value: string;
  cast: readonly string[];
  onCommit: (body: string) => Promise<unknown>;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const [stored, setStored] = useState(value);
  const [current, setCurrent] = useState<ScriptElementType>('action');
  const area = useRef<HTMLTextAreaElement>(null);
  if (value !== stored) {
    setStored(value);
    setDraft(value);
  }
  const lineAt = (text: string, caret: number): number =>
    text.slice(0, caret).split('\n').length - 1;
  const look = (text: string, caret: number): void => {
    setCurrent(lineType(text.split('\n'), lineAt(text, caret)));
  };
  const apply = (next: { text: string; caret: number }, save = false): void => {
    setDraft(next.text);
    look(next.text, next.caret);
    if (save && next.text !== value) void onCommit(next.text);
    requestAnimationFrame(() => {
      const element = area.current;
      if (element === null) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };
  const make = (type: ScriptElementType): void => {
    const element = area.current;
    if (element === null) return;
    apply(makeLine(draft, element.selectionStart, type), true);
  };
  const speaker = (name: string): void => {
    const element = area.current;
    if (element === null) return;
    const lines = draft.split('\n');
    const at = lineAt(draft, element.selectionStart);
    const empty = (lines[at] ?? '').trim() === '';
    // On an empty line the name is written there; otherwise it starts a new block below.
    const caret = empty ? element.selectionStart : lines.slice(0, at + 1).join('\n').length;
    const base = empty ? draft : `${draft.slice(0, caret)}\n\n${draft.slice(caret)}`;
    const start = empty ? caret : caret + 2;
    const named = `${base.slice(0, start)}${name.toUpperCase()}\n${base.slice(start)}`;
    const placed = makeLine(named, start, 'character');
    apply({ text: placed.text, caret: placed.caret + 1 }, true);
  };
  return (
    <div className="screenplay-writer">
      <div className="sp-tools" role="toolbar" aria-label="Parts of a screenplay">
        {CYCLE.map((type) => (
          <button
            key={type}
            type="button"
            className="button quiet sp-tool"
            aria-pressed={current === type}
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              make(type);
            }}
          >
            {TYPE_NAMES[type]}
          </button>
        ))}
        {cast.length > 0 && <span className="markup-sep" aria-hidden="true" />}
        {cast.map((name) => (
          <button
            key={name}
            type="button"
            className="button quiet sp-tool sp-name"
            title={`${name} speaks`}
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              speaker(name);
            }}
          >
            {name.toUpperCase()}
          </button>
        ))}
      </div>
      <textarea
        ref={area}
        className="input script sp-text"
        aria-label="Scene text, in Fountain"
        rows={18}
        value={draft}
        spellCheck
        placeholder={'Rain hammers the glass.\n\nMARA\n(shouting)\nHold the light!'}
        onChange={(event) => {
          setDraft(event.target.value);
          look(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => {
          look(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onBlur={() => {
          if (draft !== value) void onCommit(draft);
        }}
        onKeyDown={(event) => {
          const element = event.currentTarget;
          if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            const at = CYCLE.indexOf(current);
            const next =
              CYCLE[(at + (event.shiftKey ? CYCLE.length - 1 : 1)) % CYCLE.length] ?? 'action';
            apply(makeLine(draft, element.selectionStart, next));
            return;
          }
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            current === 'dialogue' &&
            element.selectionStart === element.selectionEnd &&
            (draft[element.selectionStart] ?? '\n') === '\n'
          ) {
            // After a line of speech comes the next block, not more of the same speech.
            event.preventDefault();
            const caret = element.selectionStart;
            apply({ text: `${draft.slice(0, caret)}\n\n${draft.slice(caret)}`, caret: caret + 2 });
          }
        }}
      />
      <p className="muted small">
        Tab turns a line into the next part, Shift+Tab the one before. A name in capitals on its own
        line speaks the lines under it; *italic* and **bold** mark emphasis.
      </p>
    </div>
  );
}

/** The scene's text as a page and as Fountain: to read, and to write in. */
export function SceneScript({
  project,
  sceneId,
  heading,
  body,
  cast,
  shotNumbers,
  act,
}: {
  project: Project;
  sceneId: string;
  heading: string;
  body: string;
  cast: readonly string[];
  shotNumbers: ReadonlyMap<string, number>;
  act: Act;
}): ReactElement {
  const [writing, setWriting] = useState(body.trim() === '');
  const lines = useScriptLines(project, sceneId);
  const unscripted = lines.data?.unscripted ?? [];
  const commit = (next: string): Promise<unknown> =>
    act('movie.scene.update', { sceneId, body: next });
  return (
    <div className="scene-script">
      <div className="row spread wrap">
        <div className="segmented" role="group" aria-label="Show the scene as">
          <button
            type="button"
            aria-pressed={!writing}
            onClick={() => {
              setWriting(false);
            }}
          >
            <ArticleIcon aria-hidden="true" /> Page
          </button>
          <button
            type="button"
            aria-pressed={writing}
            onClick={() => {
              setWriting(true);
            }}
          >
            <PencilSimpleLineIcon aria-hidden="true" /> Write
          </button>
        </div>
      </div>
      <div className={writing ? 'scene-script-body writing' : 'scene-script-body'}>
        {writing && <ScreenplayWriter value={body} cast={cast} onCommit={commit} />}
        <ScreenplayPage
          heading={heading}
          body={body}
          lines={lines.data?.lines ?? []}
          shotNumbers={shotNumbers}
          {...(writing
            ? {}
            : {
                onWrite: () => {
                  setWriting(true);
                },
              })}
        />
      </div>
      {unscripted.length > 0 && (
        <div className="unscripted">
          <h3>Spoken in shots, not in the script</h3>
          <ul>
            {unscripted.map((line) => (
              <li key={line.shotId} className="row spread wrap">
                <span>
                  <span className="muted">Shot {line.position}</span>
                  {line.speaker === null ? ' ' : ` · ${line.speaker}: `}
                  <q>{line.words}</q>
                </span>
                <button
                  type="button"
                  className="button quiet small"
                  onClick={() => {
                    const cue = (line.speaker ?? 'SOMEONE').toUpperCase();
                    const next = `${body.trimEnd()}\n\n${cue}\n${line.words}\n`;
                    void commit(next.trimStart());
                  }}
                >
                  <PlusIcon aria-hidden="true" /> Add to the script
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const Exported = z.object({ blobKey: z.string(), fileName: z.string(), mediaType: z.string() });
const Imported = z.object({ scenes: z.array(z.object({ id: z.string() })) });

/** Writing the script as a file to download, and bringing a script in from one. */
export function ScriptFiles({
  project,
  onImported,
}: {
  project: Project;
  onImported?: (sceneId: string) => void;
}): ReactElement {
  const imp = useImp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = (format: 'pdf' | 'fountain' | 'fdx'): void => {
    setBusy(format);
    setError(null);
    void (async () => {
      try {
        const file = Exported.parse(
          await runCommand(imp, 'movie.script.export', { projectId: project.id, format }),
        );
        const blob = await imp.blob(file.blobKey);
        if (blob === undefined) throw new Error('The file went missing.');
        saveFile(blob.bytes, file.mediaType, file.fileName);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(null);
      }
    })();
  };
  return (
    <div className="script-files row wrap" role="group" aria-label="Script files">
      <button
        type="button"
        className="button quiet"
        disabled={busy !== null}
        onClick={() => {
          input.current?.click();
        }}
      >
        <UploadSimpleIcon aria-hidden="true" /> Import
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept=".fountain,.spmd,.txt,.fdx,text/plain,application/xml"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          setBusy('import');
          setError(null);
          void (async () => {
            try {
              const fileKey = await imp.upload(
                new Uint8Array(await file.arrayBuffer()),
                file.type || 'text/plain',
              );
              const result = Imported.parse(
                await runCommand(imp, 'movie.script.import', { projectId: project.id, fileKey }),
              );
              const first = result.scenes[0];
              if (first !== undefined) onImported?.(first.id);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
              setBusy(null);
            }
          })();
        }}
      />
      <span className="muted small">Download</span>
      {(
        [
          ['pdf', 'PDF'],
          ['fountain', 'Fountain'],
          ['fdx', 'Final Draft'],
        ] as const
      ).map(([format, name]) => (
        <button
          key={format}
          type="button"
          className="button quiet"
          disabled={busy !== null}
          title={
            format === 'pdf'
              ? 'The script in the standard screenplay layout, to read, print or send'
              : format === 'fountain'
                ? 'Plain text that screenwriting apps open'
                : 'For Final Draft and most production software'
          }
          onClick={() => {
            download(format);
          }}
        >
          <DownloadSimpleIcon aria-hidden="true" /> {busy === format ? 'Writing…' : name}
        </button>
      ))}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
