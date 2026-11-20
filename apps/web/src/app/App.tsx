import { useEffect, useState, type ReactElement } from 'react';
import type { Imp } from '../host/imp.js';
import { ImpContext, messageOf, runCommand } from './context.js';
import { Setup } from './Setup.js';
import { Shell } from './Shell.js';

type Stage = 'loading' | 'setup' | 'ready';

async function isSetUp(imp: Imp): Promise<boolean> {
  if (imp.secrets.getKey() === null) return false;
  const coordinator = (await runCommand(imp, 'settings.get', { key: 'coordinator.member' })) as {
    value: unknown;
  };
  return coordinator.value !== null;
}

export function App({ imp }: { imp: Imp }): ReactElement {
  const [stage, setStage] = useState<Stage>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    imp
      .start()
      .then(() => isSetUp(imp))
      .then(
        (ready) => {
          setStage(ready ? 'ready' : 'setup');
        },
        (reason: unknown) => {
          setError(messageOf(reason));
        },
      );
  }, [imp]);

  if (error !== null) {
    return (
      <main className="setup">
        <p className="error" role="alert">
          Imp could not start: {error}
        </p>
      </main>
    );
  }
  return (
    <ImpContext value={imp}>
      {stage === 'setup' && (
        <Setup
          onDone={() => {
            setStage('ready');
          }}
        />
      )}
      {stage === 'ready' && (
        <Shell
          onForgetKey={() => {
            imp.secrets.clearKey();
            setStage('setup');
          }}
        />
      )}
    </ImpContext>
  );
}
