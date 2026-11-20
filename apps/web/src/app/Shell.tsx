import { ShotsView } from './shots.js';
import { SoundView } from './sound.js';
import { CrewMember } from '@imp/agents';
import { Project } from '@imp/core';
import {
  FilmSlateIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { z } from 'zod';
import { CommandPalette } from './CommandPalette.js';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { CrewPanel } from './CrewPanel.js';
import { Resizer, usePanelWidth } from './Resizer.js';
import { CastingView, DevelopmentView, ScriptView, StartMovie } from './movie.js';
import { ActivityStrip, CrewView, SettingsView } from './views.js';

const WORKSPACE: readonly { id: string; label: string; icon: Icon }[] = [
  { id: 'crew', label: 'Crew', icon: UsersThreeIcon },
  { id: 'settings', label: 'Settings', icon: GearSixIcon },
];
const NEW_PROJECT = 'new-project';
/** The setting that says which project is open. Agents can read and change it too. */
const CURRENT_PROJECT = 'project.current';

const SettingValue = z.object({ value: z.json() });
const CrewList = z.object({ crew: z.array(CrewMember) });
const ProjectList = z.object({ projects: z.array(Project) });

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('imp.theme') ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    localStorage.setItem('imp.theme', theme);
  }, [theme]);
  return [
    theme,
    () => {
      setTheme(theme === 'dark' ? 'light' : 'dark');
    },
  ];
}

function StageView({ stage, project }: { stage: string; project: Project }): ReactElement | null {
  if (stage === 'development') return <DevelopmentView key={project.id} project={project} />;
  if (stage === 'script') return <ScriptView key={project.id} project={project} />;
  if (stage === 'casting') return <CastingView key={project.id} project={project} />;
  if (stage === 'shots') return <ShotsView key={project.id} project={project} />;
  if (stage === 'sound') return <SoundView key={project.id} project={project} />;
  return null;
}

export function Shell({ onForgetKey }: { onForgetKey: () => void }): ReactElement {
  const imp = useImp();
  const [view, setViewState] = useState(() => localStorage.getItem('imp.view') ?? 'crew');
  const setView = (next: string): void => {
    setViewState(next);
    localStorage.setItem('imp.view', next);
  };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const [theme, toggleTheme] = useTheme();
  const navWidth = usePanelWidth('nav', { initial: 220, min: 168, max: 360 });
  const crewWidth = usePanelWidth('crew', { initial: 360, min: 300, max: 720 });

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
      project: projects.find((project) => project.id === projectId) ?? projects.at(-1) ?? null,
    };
  });
  const crew = state.data?.crew ?? [];
  const projects = state.data?.projects ?? [];
  const project = state.data?.project ?? null;
  const mode = imp.modes.find((candidate) => candidate.id === (project?.mode ?? 'movie'));
  const stages = mode?.stages ?? [];
  const active =
    crew.find((member) => member.id === talkingTo) ?? state.data?.coordinator ?? crew[0];

  const openProject = (id: string): void => {
    runCommand(imp, 'settings.set', { key: CURRENT_PROJECT, value: id }).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  };

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

  const viewLabel =
    [...WORKSPACE, ...stages.map((stage) => ({ id: stage.id, label: stage.name }))].find(
      (candidate) => candidate.id === view,
    )?.label ?? 'New project';
  const context =
    project === null
      ? `No project is open. A new one is made with project.create; the setting "${CURRENT_PROJECT}" holds the id of the open project.`
      : `Open project: "${project.name}" (projectId "${project.id}", mode ${project.mode}). The user is looking at: ${viewLabel}.`;

  const isStage = stages.some((stage) => stage.id === view);
  const startMovie = (
    <StartMovie
      onCreated={(created) => {
        openProject(created.id);
        if (view === NEW_PROJECT) setView(stages[0]?.id ?? 'crew');
      }}
    />
  );

  return (
    <div
      className="shell"
      style={
        {
          '--nav-width': `${String(navWidth.value)}px`,
          '--crew-width': `${String(crewWidth.value)}px`,
        } as CSSProperties
      }
    >
      <header className="topbar">
        <div className="wordmark">Imp</div>
        {projects.length > 0 && (
          <div className="row project-switch">
            <label className="sr-only" htmlFor="project-select">
              Project
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
              aria-label="New project"
              title="New project"
              onClick={() => {
                setView(NEW_PROJECT);
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
            <MagnifyingGlassIcon aria-hidden="true" /> <span className="label">Run a command</span>
          </span>
          <kbd>Ctrl K</kbd>
        </button>
        <button
          className="button quiet"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
        </button>
      </header>
      <nav className="nav" aria-label="Workspace">
        <div className="eyebrow">{mode?.name ?? 'Project'}</div>
        {stages.map((stage) => (
          <button
            key={stage.id}
            className="nav-item"
            aria-current={view === stage.id ? 'page' : undefined}
            onClick={() => {
              setView(stage.id);
            }}
          >
            <FilmSlateIcon aria-hidden="true" size={18} />
            <span>{stage.name}</span>
          </button>
        ))}
        <div className="eyebrow">Workspace</div>
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
      <main className="main">
        {view === 'crew' && <CrewView />}
        {view === 'settings' && <SettingsView onForgetKey={onForgetKey} />}
        {view === NEW_PROJECT && startMovie}
        {isStage &&
          state.data !== undefined &&
          (project === null ? startMovie : <StageView stage={view} project={project} />)}
      </main>
      <ActivityStrip />
      <Resizer label="Resize the navigation" side="left" width={navWidth} />
      <Resizer label="Resize the crew panel" side="right" width={crewWidth} />
      <div className="crew">
        {crew.length > 1 && (
          <div className="field crew-switch">
            <label htmlFor="talking-to">Talking to</label>
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
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {crew.map((member) => (
          <CrewPanel
            key={member.id}
            member={member}
            context={context}
            hidden={member.id !== active?.id}
          />
        ))}
        {crew.length === 0 && (
          <div className="crew-head">
            <p className="muted">
              {state.error ?? 'Nobody is on the crew. Hire someone from the Crew view.'}
            </p>
          </div>
        )}
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}
