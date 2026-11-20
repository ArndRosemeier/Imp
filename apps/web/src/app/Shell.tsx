import { CrewMember } from '@imp/agents';
import {
  FilmSlateIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { CommandPalette } from './CommandPalette.js';
import { runCommand, useLive } from './context.js';
import { CrewPanel } from './CrewPanel.js';
import { ActivityStrip, CrewView, SettingsView } from './views.js';

type View = 'crew' | 'settings';
const VIEWS: readonly { id: View; label: string; icon: Icon }[] = [
  { id: 'crew', label: 'Crew', icon: UsersThreeIcon },
  { id: 'settings', label: 'Settings', icon: GearSixIcon },
];
const COMING = ['Development', 'Script', 'Casting'];

const Coordinator = z.object({ value: z.json() });
const CrewList = z.object({ crew: z.array(CrewMember) });

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

export function Shell({ onForgetKey }: { onForgetKey: () => void }): ReactElement {
  const [view, setView] = useState<View>('crew');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();

  const coordinator = useLive(['crew/', 'settings/'], async (imp) => {
    const { value } = Coordinator.parse(
      await runCommand(imp, 'settings.get', { key: 'coordinator.member' }),
    );
    const { crew } = CrewList.parse(await runCommand(imp, 'crew.list', {}));
    return crew.find((member) => member.id === value) ?? null;
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">Imp</div>
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
        <div className="eyebrow">Workspace</div>
        {VIEWS.map(({ id, label, icon: IconComponent }) => (
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
        <div className="eyebrow">Movie</div>
        {COMING.map((label) => (
          <button key={label} className="nav-item" disabled>
            <FilmSlateIcon aria-hidden="true" size={18} />
            <span>{label}</span>
            <small>soon</small>
          </button>
        ))}
      </nav>
      <main className="main">
        {view === 'crew' ? <CrewView /> : <SettingsView onForgetKey={onForgetKey} />}
      </main>
      <ActivityStrip />
      {coordinator.data ? (
        <CrewPanel key={coordinator.data.id} member={coordinator.data} />
      ) : (
        <aside className="crew" aria-label="Coordinator">
          <div className="crew-head">
            <p className="muted">
              {coordinator.error ?? 'No coordinator is hired. Hire one from the command palette.'}
            </p>
          </div>
        </aside>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}
