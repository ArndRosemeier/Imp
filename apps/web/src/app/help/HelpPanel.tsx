import { ArrowLeftIcon, MagnifyingGlassIcon, QuestionIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { messageOf, runCommand, useImp } from '../context.js';
import { GuideText } from './GuideText.js';
import { OPEN_HELP, useHelpState, useTopic, useTopics, type TopicListing } from './help.js';

const AREA_ORDER = ['workspace'];

/** Groups pages: Imp as a whole first, then the stages in the order the guide lists them. */
function groups(topics: readonly TopicListing[]): { area: string; topics: TopicListing[] }[] {
  const byArea = new Map<string, TopicListing[]>();
  for (const topic of topics) {
    const list = byArea.get(topic.area) ?? [];
    list.push(topic);
    byArea.set(topic.area, list);
  }
  return [...byArea.entries()]
    .sort(([a], [b]) => {
      const rank = (area: string): number => {
        const at = AREA_ORDER.indexOf(area);
        return at === -1 ? AREA_ORDER.length : at;
      };
      return rank(a) - rank(b);
    })
    .map(([area, list]) => ({ area, topics: list }));
}

/** The switch that turns every tip on or off, shared by the help panel and Settings. */
export function TipsSwitch(): ReactElement {
  const imp = useImp();
  const help = useHelpState();
  const id = useId();
  const enabled = help.data?.enabled ?? true;
  const closed = help.data?.dismissed.length ?? 0;
  const set = (next: boolean, reset = false): void => {
    runCommand(imp, 'help.set', { enabled: next, reset }).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  };
  return (
    <div className="tips-switch">
      <label className="switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-label="Show tips"
          checked={enabled}
          onChange={() => {
            set(!enabled);
          }}
        />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">
          <strong>Show tips</strong>
          <span className="muted">
            {enabled
              ? 'A short tip the first time each stage opens.'
              : 'All tips are off. This guide stays here.'}
          </span>
        </span>
      </label>
      {closed > 0 && (
        <button
          className="button quiet small"
          onClick={() => {
            set(true, true);
          }}
        >
          Show closed tips again
        </button>
      )}
    </div>
  );
}

/**
 * The help panel: Imp's guide, searchable, with the tips switch. It opens from
 * the Help button in the top bar, or at a page from anywhere through
 * `openHelp`, such as a tip's "Read more".
 */
export function HelpPanel(): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const topics = useTopics(query);
  const listed = topics.data ?? [];
  const current = chosen ?? (query.trim() === '' ? 'getting-started' : (listed[0]?.id ?? null));
  const topic = useTopic(current);
  const searchId = useId();

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      setChosen(typeof detail === 'string' ? detail : null);
      setQuery('');
      if (dialog.current?.open !== true) dialog.current?.showModal();
    };
    window.addEventListener(OPEN_HELP, onOpen);
    return () => {
      window.removeEventListener(OPEN_HELP, onOpen);
    };
  }, []);

  const page = topic.data;
  return (
    <>
      <button
        className="button quiet help-toggle"
        aria-haspopup="dialog"
        title="Help and guide"
        onClick={() => {
          setChosen(null);
          dialog.current?.showModal();
        }}
      >
        <QuestionIcon aria-hidden="true" size={18} />
        <span className="label">Help</span>
      </button>
      {/* A tap on the dimmed backdrop closes the panel, as Escape does; a tablet has no Escape key. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
      <dialog
        ref={dialog}
        className="modal help-dialog"
        aria-labelledby="help-title"
        data-reading={chosen !== null ? 'true' : undefined}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <header className="help-head">
          <div className="stack help-heading">
            <span className="eyebrow">Help</span>
            <h2 id="help-title">The Imp guide</h2>
          </div>
          <button
            className="button quiet icon"
            aria-label="Close"
            onClick={() => dialog.current?.close()}
          >
            <XIcon aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="help-layout">
          <nav className="help-index" aria-label="Guide pages">
            <label className="help-search" htmlFor={searchId}>
              <MagnifyingGlassIcon aria-hidden="true" size={16} />
              <span className="sr-only">Search the guide</span>
              <input
                id={searchId}
                className="input"
                type="search"
                placeholder="Search the guide"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setChosen(null);
                }}
              />
            </label>
            {listed.length === 0 && topics.data !== undefined && (
              <p className="muted help-none">Nothing in the guide matches. Try fewer words.</p>
            )}
            {groups(listed).map((group) => (
              <div key={group.area} className="help-group">
                <span className="eyebrow">{group.area === 'workspace' ? 'Imp' : 'Stages'}</span>
                <ul>
                  {group.topics.map((entry) => (
                    <li key={entry.id}>
                      <button
                        className="help-entry"
                        aria-current={entry.id === current ? 'page' : undefined}
                        onClick={() => {
                          setChosen(entry.id);
                        }}
                      >
                        <span className="help-entry-title">{entry.title}</span>
                        <span className="help-entry-summary">{entry.summary}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <article className="help-page" aria-live="polite">
            <button
              className="button quiet small help-back"
              onClick={() => {
                setChosen(null);
              }}
            >
              <ArrowLeftIcon aria-hidden="true" /> All pages
            </button>
            {topic.error !== null && <p className="error">{topic.error}</p>}
            {page !== null && page !== undefined && (
              <>
                <h3 className="help-page-title">{page.title}</h3>
                <p className="help-page-summary">{page.summary}</p>
                <GuideText body={page.body} />
              </>
            )}
          </article>
        </div>
        <footer className="help-foot">
          <TipsSwitch />
        </footer>
      </dialog>
    </>
  );
}
