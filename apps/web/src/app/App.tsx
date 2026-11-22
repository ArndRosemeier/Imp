import { useEffect, useState, type ReactElement } from 'react';
import type { ImpClient } from '@imp/host';
import { ImpContext, messageOf, runCommand } from './context.js';
import { OrientationNotice } from './OrientationNotice.js';
import { Setup } from './Setup.js';
import { Shell } from './Shell.js';

type Stage = 'loading' | 'setup' | 'ready';

async function isSetUp(imp: ImpClient): Promise<boolean> {
  if (!imp.secrets.hasKey()) return false;
  const coordinator = (await runCommand(imp, 'settings.get', { key: 'coordinator.member' })) as {
    value: unknown;
  };
  return coordinator.value !== null;
}

export function App({ imp }: { imp: ImpClient }): ReactElement {
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
      <OrientationNotice />
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
