import { CrewMember } from '@imp/agents';
import type { ModelInfo } from '@imp/providers';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState, type SyntheticEvent, type ReactElement } from 'react';
import { messageOf, runCommand, useImp } from './context.js';

/** Models an agent can run on: they write text and accept tools. */
export function agentModels(models: readonly ModelInfo[]): ModelInfo[] {
  return models
    .filter((model) => model.outputModalities.includes('text') && model.supportsTools)
    .sort((a, b) => {
      // "Latest" aliases follow a family as it moves, so they are the better default.
      const alias = Number(b.id.startsWith('~')) - Number(a.id.startsWith('~'));
      return alias !== 0 ? alias : a.id.localeCompare(b.id);
    });
}

export function Setup({ onDone }: { onDone: () => void }): ReactElement {
  const imp = useImp();
  const [hasKey, setHasKey] = useState(() => imp.secrets.getKey() !== null);
  const [key, setKey] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = useId();
  const modelId = useId();
  const listId = useId();

  useEffect(() => {
    if (!hasKey) return;
    let active = true;
    imp.provider.listModels().then(
      (all) => {
        if (active) setModels(agentModels(all));
      },
      (reason: unknown) => {
        if (active) setError(messageOf(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [hasKey, imp]);

  const submitKey = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    imp.secrets.setKey(key.trim());
    imp.provider.verifyCredentials().then(
      () => {
        setHasKey(true);
        setBusy(false);
      },
      (reason: unknown) => {
        imp.secrets.clearKey();
        setError(messageOf(reason));
        setBusy(false);
      },
    );
  };

  const submitModel = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    (async () => {
      await runCommand(imp, 'settings.set', { key: 'coordinator.model', value: model });
      const hired = CrewMember.parse(
        await runCommand(imp, 'crew.hire', { roleId: 'coordinator', model }),
      );
      await runCommand(imp, 'settings.set', { key: 'coordinator.member', value: hired.id });
    })().then(onDone, (reason: unknown) => {
      setError(messageOf(reason));
      setBusy(false);
    });
  };

  const known = models.some((candidate) => candidate.id === model);

  return (
    <main className="setup">
      <div className="setup-panel">
        <div className="wordmark">Imp</div>
        <div className="steps" aria-hidden="true">
          <span data-done="true" />
          <span data-done={hasKey} />
        </div>
        {!hasKey ? (
          <form className="stack" onSubmit={submitKey}>
            <h1>Connect OpenRouter</h1>
            <p className="muted">
              Imp generates everything through your OpenRouter account. The key stays in this
              browser and is sent only to OpenRouter.
            </p>
            <label className="field" htmlFor={keyId}>
              <span>OpenRouter API key</span>
              <input
                id={keyId}
                className="input"
                type="password"
                autoComplete="off"
                required
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                }}
              />
            </label>
            {error !== null && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button className="button primary" disabled={busy || key.trim() === ''}>
                {busy ? 'Checking' : 'Continue'} <ArrowRightIcon aria-hidden="true" />
              </button>
              <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                Get a key
              </a>
            </div>
          </form>
        ) : (
          <form className="stack" onSubmit={submitModel}>
            <h1>Choose your coordinator</h1>
            <p className="muted">
              The coordinator is the agent you talk to. It plans the work, hires the rest of the
              crew and can finish the setup for you. You can change the model later.
            </p>
            <label className="field" htmlFor={modelId}>
              <span>
                Model{models.length > 0 ? ` (${String(models.length)} can run agents)` : ''}
              </span>
              <input
                id={modelId}
                className="input"
                list={listId}
                required
                placeholder={models.length === 0 ? 'Loading the catalog' : 'Type to search'}
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                }}
              />
              <datalist id={listId}>
                {models.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </datalist>
            </label>
            {error !== null && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button className="button primary" disabled={busy || !known}>
                {busy ? 'Hiring' : 'Hire the coordinator'} <ArrowRightIcon aria-hidden="true" />
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
