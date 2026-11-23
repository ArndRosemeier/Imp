import { AudioView, OPEN_VIEW } from './audio.js';
import { EditView } from './edit.js';
import { ImpMark } from './ImpMark.js';
import { aliasOfTheVisit } from './imp-names.js';
import { ShotsView } from './shots.js';
import { SoundView } from './sound.js';
import { CrewMember, GLOBAL_COORDINATOR_ROLE } from '@imp/agents';
import { Project } from '@imp/core';
import {
  BooksIcon,
  ChatsCircleIcon,
  FilmSlateIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GlobeHemisphereWestIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlusIcon,
  SquaresFourIcon,
  SunIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { z } from 'zod';
import { CommandPalette } from './CommandPalette.js';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { Approvals } from './Approvals.js';
import { CrewPanel } from './CrewPanel.js';
import { isCoarsePointer } from './gestures.js';
import { Resizer, usePanelWidth } from './Resizer.js';
import { DesignView } from './design.js';
import { CastingView, DevelopmentView, ScriptView, StartMovie } from './movie.js';
import { WhatsNew } from './WhatsNew.js';
import { HelpPanel } from './help/HelpPanel.js';
import { FirstFilm } from './help/FirstFilm.js';
import { ASK_COORDINATOR } from './help/help.js';
import { StageTip } from './help/StageTip.js';
import { ActivityStrip, CrewView, SettingsView } from './views.js';
import { BackupWatcher } from './backup.js';
import { CopyQuestions, ProjectsView } from './projects.js';
import { LibraryDragProvider } from './library/drag.js';
import { LibraryPanel } from './library/LibraryPanel.js';
import { FilmNotices, SHOW_FILMS } from './films.js';
import { SpendTotal } from './spend.js';
import { STAGE_ICONS } from './stage-icons.js';
import { t, tx } from '../i18n/i18n.js';
import { StageWorkers, TALK_TO, WorkIndicator, WorkProvider } from './work.js';

const WORKSPACE: readonly { id: string; label: string; icon: Icon }[] = [
  {
    id: 'projects',
    get label(): string {
      return t('Projects');
    },
    icon: SquaresFourIcon,
  },
  {
    id: 'crew',
    get label(): string {
      return t('Crew');
    },
    icon: UsersThreeIcon,
  },
  {
    id: 'settings',
    get label(): string {
      return t('Settings');
    },
    icon: GearSixIcon,
  },
];
/** The setting that says which project is open. Agents can read and change it too. */
const CURRENT_PROJECT = 'project.current';

const SettingValue = z.object({ value: z.json() });
const CrewList = z.object({ crew: z.array(CrewMember) });
const ProjectList = z.object({ projects: z.array(Project) });

/** The setting that holds the theme, so agents can switch it too. */
const THEME_SETTING = 'ui.theme';

function useTheme(): [string, () => void] {
  const imp = useImp();
  // The browser keeps a copy, so the first paint already has the right colours.
  const [local, setLocal] = useState(() => localStorage.getItem('imp.theme') ?? 'dark');
  const stored = useLive(
    [`settings/${THEME_SETTING}`],
    async (current) =>
      SettingValue.parse(await runCommand(current, 'settings.get', { key: THEME_SETTING })).value,
  );
  const theme = stored.data === 'dark' || stored.data === 'light' ? stored.data : local;
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    localStorage.setItem('imp.theme', theme);
  }, [theme]);
  return [
    theme,
    () => {
      const next = theme === 'dark' ? 'light' : 'dark';
      setLocal(next);
      runCommand(imp, 'settings.set', { key: THEME_SETTING, value: next }).catch(() => {
        // The theme still changes in this browser; only the stored copy is missing.
      });
    },
  ];
}

/** The least room the stage keeps between the side panels. */
const STAGE_MIN_WIDTH = 760;

/**
 * Whether the crew panel is shown. Remembered in this browser; on a tablet
 * narrower than 1200 pixels it starts closed, so the stage gets the room.
 */
function useCrewOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem('imp.crew.open');
    if (stored !== null) return stored === 'true';
    return !(isCoarsePointer() && window.innerWidth < 1200);
  });
  return [
    open,
    () => {
      localStorage.setItem('imp.crew.open', String(!open));
      setOpen(!open);
    },
  ];
}

/** A switch remembered in this browser, such as whether the library is open. */
function useStoredFlag(key: string, initial: () => boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial() : stored === 'true';
    } catch {
      return initial();
    }
  });
  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Remembering it is a convenience.
      }
      setValue(next);
    },
    [key],
  );
  return [value, set];
}

function StageView({ stage, project }: { stage: string; project: Project }): ReactElement | null {
  if (stage === 'development') return <DevelopmentView key={project.id} project={project} />;
  if (stage === 'script') return <ScriptView key={project.id} project={project} />;
  if (stage === 'casting') return <CastingView key={project.id} project={project} />;
  if (stage === 'design') return <DesignView key={project.id} project={project} />;
  if (stage === 'shots') return <ShotsView key={project.id} project={project} />;
  if (stage === 'sound') return <SoundView key={project.id} project={project} />;
  if (stage === 'edit') return <EditView key={project.id} project={project} />;
  if (stage === 'audio') return <AudioView key={project.id} project={project} />;
  return null;
}

export function Shell({ onForgetKey }: { onForgetKey: () => void }): ReactElement {
  const imp = useImp();
  const [view, setViewState] = useState(() => localStorage.getItem('imp.view') ?? 'projects');
  const setView = (next: string): void => {
    if ((next === 'projects') !== (view === 'projects')) {
      setChatScope(next === 'projects' ? 'all' : 'project');
    }
    setViewState(next);
    localStorage.setItem('imp.view', next);
  };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  // Which chat the crew panel shows: the Imp coordinator's, for all projects, or the open
  // project's. The start screen starts on the one for all projects, a stage on the project's.
  const [chatScope, setChatScope] = useState<'all' | 'project'>(() =>
    view === 'projects' ? 'all' : 'project',
  );
  const [theme, toggleTheme] = useTheme();
  const [crewOpen, toggleCrew] = useCrewOpen();
  const [libraryOpen, setLibraryOpen] = useStoredFlag('imp.library.open', () => false);
  const [libraryWide, setLibraryWide] = useStoredFlag('imp.library.wide', () => false);
  const libraryWidth = usePanelWidth('library', { initial: 340, min: 280, max: 640 });
  const navWidth = usePanelWidth('nav', { initial: 220, min: 168, max: 360 });
  const crewWidth = usePanelWidth('crew', { initial: 360, min: 300, max: 720 });
  // When both side panels would leave the stage too little room, the library and the crew take turns.
  const crowded = (): boolean =>
    window.innerWidth - navWidth.value - libraryWidth.value - crewWidth.value < STAGE_MIN_WIDTH;
  const openLibrary = (next: boolean): void => {
    if (next && crewOpen && crowded()) toggleCrew();
    setLibraryOpen(next);
  };
  const switchCrew = (): void => {
    if (!crewOpen && libraryOpen && crowded()) setLibraryOpen(false);
    toggleCrew();
  };

  const state = useLive(['crew/', 'settings/', 'project-index/'], async (current) => {
    const setting = async (key: string): Promise<unknown> =>
      SettingValue.parse(await runCommand(current, 'settings.get', { key })).value;
    const { crew } = CrewList.parse(await runCommand(current, 'crew.list', {}));
    const { projects } = ProjectList.parse(await runCommand(current, 'project.list', {}));
    const coordinatorId = await setting('coordinator.member');
    const projectId = await setting(CURRENT_PROJECT);
    return {
      crew,
      projects,
      coordinator: crew.find((member) => member.id === coordinatorId) ?? null,
      globalCoordinator: crew.find((member) => member.roleId === GLOBAL_COORDINATOR_ROLE) ?? null,
      project: projects.find((project) => project.id === projectId) ?? projects.at(-1) ?? null,
    };
  });
  const everyone = state.data?.crew ?? [];
  const globalCoordinator = state.data?.globalCoordinator ?? null;
  // The project's crew; the Imp coordinator has a chat of its own.
  const crew = everyone.filter((member) => member.id !== globalCoordinator?.id);
  const projects = state.data?.projects ?? [];
  const project = state.data?.project ?? null;
  const mode = imp.modes.find((candidate) => candidate.id === (project?.mode ?? 'movie'));
  const stages = mode?.stages ?? [];
  const active =
    crew.find((member) => member.id === talkingTo) ?? state.data?.coordinator ?? crew[0];
  // Without a project there is only the chat for all projects.
  const scope =
    globalCoordinator !== null && (chatScope === 'all' || project === null) ? 'all' : 'project';

  // Every Imp has an Imp coordinator for what concerns all projects. One set up before it
  // existed gets it on the agents' model, like the coordinator's.
  const hiring = useRef(false);
  const projectCoordinator = state.data?.coordinator ?? null;
  useEffect(() => {
    if (state.data === undefined || globalCoordinator !== null || projectCoordinator === null) {
      return;
    }
    if (hiring.current) return;
    hiring.current = true;
    runCommand(imp, 'crew.hire', {
      roleId: GLOBAL_COORDINATOR_ROLE,
      model: projectCoordinator.model,
      budgetUsdPerRun: projectCoordinator.budgetUsdPerRun,
    }).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  }, [imp, state.data, globalCoordinator, projectCoordinator]);

  const openProject = (id: string): void => {
    runCommand(imp, 'project.open', { projectId: id }).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  };

  // Views can send the person to another view, such as the Edit stage to the audio editor.
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const next = (event as CustomEvent<unknown>).detail;
      if (typeof next === 'string') {
        setViewState(next);
        localStorage.setItem('imp.view', next);
      }
    };
    window.addEventListener(OPEN_VIEW, onOpen);
    return () => {
      window.removeEventListener(OPEN_VIEW, onOpen);
    };
  }, []);

  // The work board can open the conversation with whoever is working or waiting.
  useEffect(() => {
    const onTalk = (event: Event): void => {
      const memberId = (event as CustomEvent<unknown>).detail;
      if (typeof memberId !== 'string') return;
      if (memberId === globalCoordinator?.id) {
        setChatScope('all');
      } else {
        setChatScope('project');
        setTalkingTo(memberId);
      }
      if (!crewOpen) switchCrew();
    };
    window.addEventListener(TALK_TO, onTalk);
    return () => {
      window.removeEventListener(TALK_TO, onTalk);
    };
  });

  // A film's Watch button or a chat card opens the library on its Films shelf, on a stage.
  useEffect(() => {
    const onShowFilms = (): void => {
      openLibrary(true);
      if (view === 'projects') setView(stages[0]?.id ?? 'crew');
    };
    window.addEventListener(SHOW_FILMS, onShowFilms);
    return () => {
      window.removeEventListener(SHOW_FILMS, onShowFilms);
    };
  });

  // A suggestion for the coordinator, such as a step of the guided path, brings its panel up.
  const coordinatorId = state.data?.coordinator?.id;
  useEffect(() => {
    const onSuggest = (): void => {
      setChatScope('project');
      if (coordinatorId !== undefined) setTalkingTo(coordinatorId);
      if (!crewOpen) switchCrew();
    };
    window.addEventListener(ASK_COORDINATOR, onSuggest);
    return () => {
      window.removeEventListener(ASK_COORDINATOR, onSuggest);
    };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        openLibrary(!libraryOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // For agents, which read English: where the person is, by the stage's English name or the view's id.
  const viewLabel = stages.find((stage) => stage.id === view)?.name ?? view;
  const context =
    project === null
      ? // i18n-ignore
        `No project is open. A new one is made with project.create and opened with project.open; the setting "${CURRENT_PROJECT}" holds the id of the open project.`
      : // i18n-ignore
        `Open project: "${project.name}" (projectId "${project.id}", mode ${project.mode}). The user is looking at: ${viewLabel}.`;

  const isStage = stages.some((stage) => stage.id === view);
  const startMovie = (
    <StartMovie
      onCreated={(created) => {
        openProject(created.id);
      }}
    />
  );

  const showLibrary = libraryOpen && project !== null && view !== 'projects';
  return (
    <LibraryDragProvider>
      <WorkProvider>
        <div
          className="shell"
          data-crew={crewOpen ? 'open' : 'closed'}
          data-library={showLibrary ? (libraryWide ? 'wide' : 'open') : 'closed'}
          style={
            {
              '--nav-width': `${String(navWidth.value)}px`,
              '--crew-width': `${String(crewWidth.value)}px`,
              '--library-width': `${String(libraryWidth.value)}px`,
            } as CSSProperties
          }
        >
          <header className="topbar">
            <div className="wordmark" title={t('Imp: {alias}', { alias: aliasOfTheVisit() })}>
              <ImpMark />
              Imp
            </div>
            {projects.length > 0 && (
              <div className="row project-switch">
                <label className="sr-only" htmlFor="project-select">
                  {t('Project')}
                </label>
                <select
                  id="project-select"
                  className="select"
                  value={project?.id ?? ''}
                  onChange={(event) => {
                    openProject(event.target.value);
                  }}
                >
                  {projects.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                <button
                  className="button quiet"
                  aria-label={t('New project')}
                  title={t('New project')}
                  onClick={() => {
                    setView('projects');
                    setCreating(true);
                  }}
                >
                  <PlusIcon aria-hidden="true" />
                </button>
              </div>
            )}
            <button
              className="button palette-trigger"
              onClick={() => {
                setPaletteOpen(true);
              }}
            >
              <span className="row">
                <MagnifyingGlassIcon aria-hidden="true" />{' '}
                <span className="label">{t('Run a command')}</span>
              </span>
              <kbd>{t('Ctrl K')}</kbd>
            </button>
            {project !== null && (
              <button
                className="button quiet library-toggle"
                aria-label={t('Library')}
                aria-pressed={showLibrary}
                aria-controls="library-panel"
                title={
                  showLibrary
                    ? t('Hide the library (Ctrl Shift L)')
                    : t('Show the library (Ctrl Shift L)')
                }
                onClick={() => {
                  if (view === 'projects') {
                    const firstStage = stages[0];
                    if (firstStage !== undefined) setView(firstStage.id);
                    openLibrary(true);
                  } else {
                    openLibrary(!showLibrary);
                  }
                }}
              >
                <BooksIcon aria-hidden="true" size={18} />{' '}
                <span className="label">{t('Library')}</span>
              </button>
            )}
            <button
              className="button quiet crew-toggle"
              aria-label={t('Crew panel')}
              aria-pressed={crewOpen}
              aria-controls="crew-panel"
              title={crewOpen ? t('Hide the crew panel') : t('Show the crew panel')}
              onClick={switchCrew}
            >
              <ChatsCircleIcon aria-hidden="true" size={18} />{' '}
              <span className="label">{t('Crew')}</span>
            </button>
            <WorkIndicator />
            <SpendTotal />
            <HelpPanel context={context} />
            <WhatsNew />
            <button
              className="button quiet"
              aria-label={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
            </button>
          </header>
          <nav className="nav" aria-label={t('Workspace')}>
            <div className="eyebrow">{mode === undefined ? t('Project') : tx(mode.name)}</div>
            {stages.map((stage) => {
              const StageIcon = STAGE_ICONS[stage.id] ?? FilmSlateIcon;
              return (
                <button
                  key={stage.id}
                  className="nav-item"
                  aria-current={view === stage.id ? 'page' : undefined}
                  onClick={() => {
                    setView(stage.id);
                  }}
                >
                  <StageIcon aria-hidden="true" size={18} />
                  <span>{tx(stage.name)}</span>
                  <StageWorkers stage={stage.id} />
                </button>
              );
            })}
            <div className="eyebrow">{t('Workspace')}</div>
            {WORKSPACE.map(({ id, label, icon: IconComponent }) => (
              <button
                key={id}
                className="nav-item"
                aria-current={view === id ? 'page' : undefined}
                onClick={() => {
                  setView(id);
                }}
              >
                <IconComponent aria-hidden="true" size={18} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <main className="main" data-stage={isStage ? view : undefined}>
            {view === 'crew' && <CrewView />}
            {view === 'settings' && <SettingsView onForgetKey={onForgetKey} />}
            {view === 'projects' && (
              <ProjectsView
                creating={creating}
                onCreatingChange={setCreating}
                onOpen={(id) => {
                  openProject(id);
                  const opened = projects.find((candidate) => candidate.id === id);
                  const firstStage = imp.modes.find((m) => m.id === (opened?.mode ?? 'movie'))
                    ?.stages[0];
                  setView(firstStage?.id ?? 'crew');
                }}
              />
            )}
            {isStage &&
              state.data !== undefined &&
              (project === null ? (
                startMovie
              ) : (
                <>
                  <FirstFilm
                    stage={view}
                    stageNames={Object.fromEntries(
                      stages.map((stage) => [stage.id, tx(stage.name)]),
                    )}
                  />
                  <StageTip key={view} stage={view} />
                  <StageView stage={view} project={project} />
                </>
              ))}
          </main>
          {showLibrary && (
            <div className="library-column" id="library-panel">
              <LibraryPanel
                key={project.id}
                project={project}
                wide={libraryWide}
                onToggleWide={() => {
                  setLibraryWide(!libraryWide);
                }}
                onClose={() => {
                  setLibraryOpen(false);
                }}
              />
            </div>
          )}
          {showLibrary && !libraryWide && (
            <Resizer
              label={t('Resize the library')}
              side="right"
              panel="library"
              width={libraryWidth}
            />
          )}
          <ActivityStrip />
          <BackupWatcher />
          <FilmNotices projectId={project?.mode === 'movie' ? project.id : null} />
          <Resizer label={t('Resize the navigation')} side="left" width={navWidth} />
          {crewOpen && (
            <Resizer
              label={t('Resize the crew panel')}
              side="right"
              panel="crew"
              width={crewWidth}
            />
          )}
          <div className="crew" id="crew-panel" data-scope={scope}>
            {globalCoordinator !== null && (
              <div className="chat-scope" role="tablist" aria-label={t('Which chat')}>
                <button
                  type="button"
                  role="tab"
                  data-scope="all"
                  aria-selected={scope === 'all'}
                  aria-controls="chat-all"
                  title={t('The Imp coordinator: settings, models, crews and projects')}
                  onClick={() => {
                    setChatScope('all');
                  }}
                >
                  <GlobeHemisphereWestIcon aria-hidden="true" size={16} />
                  <span>{t('All projects')}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  data-scope="project"
                  aria-selected={scope === 'project'}
                  disabled={project === null}
                  title={
                    project === null
                      ? t('Open a project to talk about it')
                      : t('The crew of {project}', { project: project.name })
                  }
                  onClick={() => {
                    setChatScope('project');
                  }}
                >
                  <FolderSimpleIcon aria-hidden="true" size={16} />
                  <span className="chat-scope-name">{project?.name ?? t('No project open')}</span>
                </button>
              </div>
            )}
            {scope === 'project' && crew.length > 1 && (
              <div className="field crew-switch">
                <label htmlFor="talking-to">{t('Talking to')}</label>
                <select
                  id="talking-to"
                  className="select"
                  value={active?.id ?? ''}
                  onChange={(event) => {
                    setTalkingTo(event.target.value);
                  }}
                >
                  {crew.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {tx(candidate.name)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {globalCoordinator !== null && (
              <CrewPanel
                key={globalCoordinator.id}
                id="chat-all"
                member={globalCoordinator}
                place={{ kind: 'all' }}
                context={context}
                hidden={scope !== 'all'}
                intro={() => (
                  <p className="muted">
                    {t(
                      'The Imp coordinator looks after what concerns all projects: settings, models, saved crews, roles, and creating, copying or deleting projects. It hands the work inside a project to that project’s coordinator, and project coordinators pass such asks on to it.',
                    )}
                  </p>
                )}
              />
            )}
            {crew.map((member) => (
              <CrewPanel
                key={member.id}
                member={member}
                place={{ kind: 'project', name: project?.name ?? null }}
                globalCoordinatorId={globalCoordinator?.id}
                context={context}
                hidden={scope !== 'project' || member.id !== active?.id}
                takesSuggestions={member.id === state.data?.coordinator?.id}
              />
            ))}
            {crew.length === 0 && scope === 'project' && (
              <div className="crew-head">
                <p className="muted">
                  {state.error ?? t('Nobody is on the crew. Hire someone from the Crew view.')}
                </p>
              </div>
            )}
          </div>
          <Approvals />
          <CopyQuestions />
          <CommandPalette
            open={paletteOpen}
            onClose={() => {
              setPaletteOpen(false);
            }}
          />
        </div>
      </WorkProvider>
    </LibraryDragProvider>
  );
}
