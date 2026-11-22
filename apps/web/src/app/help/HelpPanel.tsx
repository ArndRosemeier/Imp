import { CrewMember } from '@imp/agents';
import {
  ArrowLeftIcon,
  BookOpenTextIcon,
  ChatTeardropTextIcon,
  MagnifyingGlassIcon,
  QuestionIcon,
  XIcon,
} from '@phosphor-icons/react';
import { z } from 'zod';
import { CrewPanel } from '../CrewPanel.js';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { messageOf, runCommand, useImp, useLive } from '../context.js';
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

const EXAMPLES = [
  'How do I make my first film?',
  'What does a 4 second clip cost?',
  'How do I add a dissolve between two shots?',
  'Turn off all tips',
];

/**
 * Ask Imp: a conversation with the help agent, which answers from the guide
 * and can do a step for the person. It is hired the first time it is needed,
 * on the coordinator's model, as an ordinary member of the crew.
 */
function AskImp({ context }: { context: string }): ReactElement {
  const imp = useImp();
  const [problem, setProblem] = useState<string | null>(null);
  const state = useLive(['crew/', 'settings/coordinator.model'], async (current) => {
    const { crew } = z
      .object({ crew: z.array(CrewMember) })
      .parse(await runCommand(current, 'crew.list', {}));
    const model = z
      .object({ value: z.json() })
      .parse(await runCommand(current, 'settings.get', { key: 'coordinator.model' })).value;
    return {
      guide: crew.find((member) => member.roleId === 'guide') ?? null,
      model: typeof model === 'string' ? model : null,
    };
  });
  const guide = state.data?.guide ?? null;
  const model = state.data?.model ?? null;
  const hiring = useRef(false);
  useEffect(() => {
    if (state.data === undefined || guide !== null || model === null || hiring.current) return;
    hiring.current = true;
    runCommand(imp, 'crew.hire', { roleId: 'guide', model, budgetUsdPerRun: 0.5 }).catch(
      (reason: unknown) => {
        setProblem(messageOf(reason));
      },
    );
  }, [imp, state.data, guide, model]);

  if (guide === null) {
    return (
      <p className="muted ask-waiting" role="status">
        {problem ??
          state.error ??
          (model === null ? 'Choose a coordinator model first.' : 'One moment…')}
      </p>
    );
  }
  return (
    <CrewPanel
      member={guide}
      context={`${context} The person is asking for help from the Help panel.`}
      intro={(suggest) => (
        <div className="ask-intro stack">
          <p>
            Ask anything about Imp in your own words. Imp answers from its guide, and does the step
            for you if you ask. It asks before spending money.
          </p>
          <div className="ask-examples" role="group" aria-label="Example questions">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="button small ask-example"
                onClick={() => {
                  suggest(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
    />
  );
}

/**
 * The help panel: Imp's guide, searchable, with the tips switch. It opens from
 * the Help button in the top bar, or at a page from anywhere through
 * `openHelp`, such as a tip's "Read more".
 */
export function HelpPanel({ context }: { context: string }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'ask' | 'guide'>('ask');
  // Ask Imp is only set up once someone opens the panel, so nobody is hired unasked.
  const [opened, setOpened] = useState(false);
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
      setTab(typeof detail === 'string' ? 'guide' : 'ask');
      setQuery('');
      setOpened(true);
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
          setTab('ask');
          setOpened(true);
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
            <h2 id="help-title">{tab === 'ask' ? 'Ask Imp' : 'The Imp guide'}</h2>
          </div>
          <div className="help-tabs" role="tablist" aria-label="Help">
            <button
              role="tab"
              aria-selected={tab === 'ask'}
              className="help-tab"
              onClick={() => {
                setTab('ask');
              }}
            >
              <ChatTeardropTextIcon aria-hidden="true" size={16} /> Ask Imp
            </button>
            <button
              role="tab"
              aria-selected={tab === 'guide'}
              className="help-tab"
              onClick={() => {
                setTab('guide');
              }}
            >
              <BookOpenTextIcon aria-hidden="true" size={16} /> Guide
            </button>
          </div>
          <button
            className="button quiet icon"
            aria-label="Close"
            onClick={() => dialog.current?.close()}
          >
            <XIcon aria-hidden="true" size={18} />
          </button>
        </header>
        {tab === 'ask' && opened && (
          <div className="help-ask">
            <AskImp context={context} />
          </div>
        )}
        <div className="help-layout" hidden={tab !== 'guide'}>
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
