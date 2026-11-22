import { CrewMember, priceVideo } from '@imp/agents';
import type { ModelInfo } from '@imp/providers';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CircleIcon,
  CompassIcon,
  LightningIcon,
} from '@phosphor-icons/react';
import { useEffect, useId, useState, type SyntheticEvent, type ReactElement } from 'react';
import { messageOf, runCommand, useImp } from './context.js';
import { ImpMark } from './ImpMark.js';
import { starterMixes, type StarterMix } from './onboarding/presets.js';
import { formatUsd } from './spend.js';

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

/** What a 4 second 720p clip with sound costs in a mix, from its video model's price list, for the card. */
function clipPrice(mix: StarterMix, models: readonly ModelInfo[]): string | null {
  const id = mix.models['video.model'];
  const pricing = models.find((model) => model.id === id)?.video?.pricing;
  if (pricing === undefined) return null;
  const usd = priceVideo(pricing, 4, '720p', true);
  return usd === undefined ? null : formatUsd(usd);
}

/** A model id without its vendor, as it reads on a card: "claude-haiku-latest". */
function shortName(id: string | undefined): string {
  if (id === undefined) return 'not available';
  return id.replace(/^~/, '').split('/').at(-1) ?? id;
}

/** The choice between tips while learning and none at all, asked once on the first run. */
function HelpChoice({
  guided,
  onChange,
}: {
  guided: boolean;
  onChange: (guided: boolean) => void;
}): ReactElement {
  const options = [
    {
      value: true,
      icon: CompassIcon,
      title: 'Guide me',
      body: 'A short tip the first time each stage opens.',
    },
    {
      value: false,
      icon: LightningIcon,
      title: 'I know my way around',
      body: 'No tips. Help stays one tap away.',
    },
  ];
  return (
    <fieldset className="setup-help">
      <legend className="eyebrow">Help while you work</legend>
      <div className="setup-help-options">
        {options.map((option) => (
          <label key={option.title} className="setup-help-option" aria-label={option.title}>
            <input
              type="radio"
              name="help"
              checked={guided === option.value}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <option.icon aria-hidden="true" size={20} />
            <span>
              <strong>{option.title}</strong>
              <span className="muted">{option.body}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The first run: connect OpenRouter, pick a starter mix of models (or choose
 * them one by one), and say how much help is wanted. Everything it does is
 * ordinary commands, so the coordinator could do the rest of the setup too.
 */
export function Setup({ onDone }: { onDone: () => void }): ReactElement {
  const imp = useImp();
  const [hasKey, setHasKey] = useState(() => imp.secrets.getKey() !== null);
  const [key, setKey] = useState('');
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [custom, setCustom] = useState(false);
  const [chosen, setChosen] = useState<StarterMix['id']>('starter');
  const [guided, setGuided] = useState(true);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = useId();
  const modelId = useId();
  const listId = useId();

  useEffect(() => {
    if (!hasKey) return;
    let active = true;
    imp.listModels().then(
      (all) => {
        if (active) setCatalog([...all]);
      },
      (reason: unknown) => {
        if (active) setError(messageOf(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [hasKey, imp]);

  const models = agentModels(catalog);
  const mixes = starterMixes(catalog).filter(
    (mix) => mix.models['coordinator.model'] !== undefined,
  );
  const mix = mixes.find((candidate) => candidate.id === chosen) ?? mixes[0];

  const submitKey = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    imp.secrets.setKey(key.trim());
    imp.verifyCredentials().then(
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

  const finish = (coordinatorModel: string, apply?: StarterMix): void => {
    setBusy(true);
    setError(null);
    (async () => {
      await runCommand(imp, 'settings.set', { key: 'coordinator.model', value: coordinatorModel });
      const hired = CrewMember.parse(
        await runCommand(imp, 'crew.hire', { roleId: 'coordinator', model: coordinatorModel }),
      );
      await runCommand(imp, 'settings.set', { key: 'coordinator.member', value: hired.id });
      if (apply !== undefined) {
        // All three are kept, so switching from drafts to the final film later is one tap.
        let appliedId: string | null = null;
        for (const starter of mixes) {
          const saved = (await runCommand(imp, 'models.mix.save', {
            name: starter.name,
            notes: starter.notes,
            models: starter.models,
          })) as { id: string };
          if (starter.id === apply.id) appliedId = saved.id;
        }
        if (appliedId !== null) await runCommand(imp, 'models.mix.apply', { id: appliedId });
      }
      if (!guided) await runCommand(imp, 'help.set', { enabled: false });
    })().then(onDone, (reason: unknown) => {
      setError(messageOf(reason));
      setBusy(false);
    });
  };

  const known = models.some((candidate) => candidate.id === model);
  // A catalog without the families the mixes use leaves only the choice by hand.
  const showCustom = custom || (catalog.length > 0 && mixes.length === 0);

  return (
    <main className="setup">
      <div className="setup-panel" data-wide={hasKey && !showCustom ? 'true' : undefined}>
        <div className="wordmark">
          <ImpMark />
          Imp
        </div>
        <div className="steps" aria-hidden="true">
          <span data-done="true" />
          <span data-done={hasKey} />
        </div>
        {!hasKey ? (
          <form className="stack" onSubmit={submitKey}>
            <h1>Connect OpenRouter</h1>
            <p className="muted">
              Imp makes pictures, voices, sound and video through your own OpenRouter account, and
              you pay OpenRouter only for what you make. The key stays in this browser and is sent
              only to OpenRouter.
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
        ) : showCustom ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              finish(model);
            }}
          >
            <h1>Choose your coordinator</h1>
            <p className="muted">
              The coordinator is the agent you talk to. It plans the work, hires the rest of the
              crew and can choose the other models for you. You can change it later.
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
            <HelpChoice guided={guided} onChange={setGuided} />
            {error !== null && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button className="button primary" disabled={busy || !known}>
                {busy ? 'Hiring' : 'Hire the coordinator'} <ArrowRightIcon aria-hidden="true" />
              </button>
              {mixes.length > 0 && (
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => {
                    setCustom(false);
                  }}
                >
                  <ArrowLeftIcon aria-hidden="true" /> Back to the starter mixes
                </button>
              )}
            </div>
          </form>
        ) : (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const coordinator = mix?.models['coordinator.model'];
              if (mix !== undefined && coordinator !== undefined) finish(coordinator, mix);
            }}
          >
            <h1>Pick your models</h1>
            <p className="muted">
              A mix is a set of models, one for each kind of work. Start cheap while you learn;
              switch to a stronger mix for the final film at any time, from any stage.
            </p>
            {catalog.length === 0 && error === null && (
              <p className="muted" role="status">
                Reading the OpenRouter catalog…
              </p>
            )}
            {mixes.length > 0 && (
              <fieldset className="mix-choices">
                <legend className="sr-only">Model mix</legend>
                {mixes.map((candidate) => {
                  const selected = candidate.id === mix?.id;
                  const clip = clipPrice(candidate, catalog);
                  return (
                    <label key={candidate.id} className="mix-choice" data-selected={selected}>
                      <input
                        type="radio"
                        name="mix"
                        className="sr-only"
                        checked={selected}
                        onChange={() => {
                          setChosen(candidate.id);
                        }}
                      />
                      <span className="mix-choice-head">
                        {selected ? (
                          <CheckCircleIcon aria-hidden="true" size={20} weight="fill" />
                        ) : (
                          <CircleIcon aria-hidden="true" size={20} />
                        )}
                        <strong>{candidate.name}</strong>
                        {candidate.id === 'starter' && (
                          <span className="tag accent">Start here</span>
                        )}
                      </span>
                      <span className="mix-choice-notes">{candidate.notes}</span>
                      <span className="mix-choice-models mono">
                        <span>Agents · {shortName(candidate.models['coordinator.model'])}</span>
                        <span>Video · {shortName(candidate.models['video.model'])}</span>
                      </span>
                      {clip !== null && (
                        <span className="mix-choice-price">
                          4 s clip with sound <span className="price">≈ {clip}</span>
                        </span>
                      )}
                    </label>
                  );
                })}
              </fieldset>
            )}
            <HelpChoice guided={guided} onChange={setGuided} />
            {error !== null && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row wrap">
              <button className="button primary" disabled={busy || mix === undefined}>
                {busy ? 'Setting up' : `Start with ${mix?.name ?? 'a mix'}`}{' '}
                <ArrowRightIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="button quiet"
                onClick={() => {
                  setCustom(true);
                }}
              >
                Choose models myself
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
