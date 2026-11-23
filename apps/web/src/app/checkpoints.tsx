import type { Project } from '@imp/core';
import { SealCheckIcon, StampIcon } from '@phosphor-icons/react';
import { useId, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { t } from '../i18n/i18n.js';

const Checkpoints = z.object({
  projectId: z.string(),
  style: z.enum(['each', 'main', 'none']),
  checkpoints: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      stage: z.string(),
      per: z.string().nullable(),
      main: z.boolean(),
      stops: z.boolean(),
      signedAt: z.string().nullable(),
      items: z.array(z.object({ itemId: z.string(), signedAt: z.string() })),
    }),
  ),
});
type Checkpoints = z.infer<typeof Checkpoints>;

/** The checkpoints of a project and its working style, kept up to date. */
function useCheckpoints(project: Project) {
  return useLive([`projects/${project.id}/checkpoints`], async (imp) =>
    Checkpoints.parse(await runCommand(imp, 'project.checkpoint.list', { projectId: project.id })),
  );
}

/** Runs a checkpoint command on the project, keeping what failed to show it. */
function useRun(project: Project): {
  run: (id: string, input: Record<string, unknown>) => void;
  error: string | null;
} {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    run: (id, input) => {
      setError(null);
      runCommand(imp, id, { projectId: project.id, ...input }).catch((reason: unknown) => {
        setError(messageOf(reason));
      });
    },
  };
}

/** The names of the checkpoints, translated; the commands speak English. */
const NAMES: Readonly<Record<string, () => string>> = {
  treatment: () => t('Treatment'),
  storyboard: () => t('Storyboard'),
  'first-cut': () => t('First cut'),
};
const nameOf = (id: string, fallback: string): string => NAMES[id]?.() ?? fallback;

/** What waits for each checkpoint, said to the person. */
const WAITING: Readonly<Record<string, () => string>> = {
  treatment: () => t('Casting, design and the scenes wait until you sign off the treatment.'),
  storyboard: () =>
    t(
      'The clips of this scene wait until you sign off its storyboard: frames cost cents, clips dollars.',
    ),
  'first-cut': () =>
    t('Music and extra sound for this scene wait until you sign off its first cut.'),
};

/**
 * One checkpoint where the person signs off what the crew made, so that the
 * next, more expensive step can start. Per item, such as a scene, when the
 * checkpoint is signed off one at a time. `compact` fits it into a toolbar.
 */
export function CheckpointBar({
  project,
  checkpointId,
  itemId,
  compact = false,
}: {
  project: Project;
  checkpointId: string;
  itemId?: string | undefined;
  compact?: boolean;
}): ReactElement | null {
  const live = useCheckpoints(project);
  const { run, error } = useRun(project);
  const checkpoint = live.data?.checkpoints.find((candidate) => candidate.id === checkpointId);
  if (checkpoint === undefined) return null;
  if (checkpoint.per !== null && itemId === undefined) return null;
  const signedAt =
    checkpoint.per === null
      ? checkpoint.signedAt
      : (checkpoint.items.find((item) => item.itemId === itemId)?.signedAt ?? null);
  const items = itemId === undefined ? {} : { itemIds: [itemId] };
  const name = nameOf(checkpoint.id, checkpoint.name);
  const sign = (): void => {
    run('project.checkpoint.approve', { checkpointId, ...items });
  };
  const reopen = (): void => {
    run('project.checkpoint.reopen', { checkpointId, ...items });
  };
  const state = signedAt !== null ? 'signed' : checkpoint.stops ? 'waiting' : ('free' as const);

  if (compact) {
    return (
      <span className="checkpoint compact" data-state={state}>
        {state === 'signed' ? (
          <button
            type="button"
            className="button quiet"
            title={t('Signed off on {date}. Press to take it back.', {
              date: new Date(signedAt ?? '').toLocaleDateString(),
            })}
            onClick={reopen}
          >
            <SealCheckIcon aria-hidden="true" /> {t('{name} signed off', { name })}
          </button>
        ) : (
          <button
            type="button"
            className={state === 'waiting' ? 'button primary' : 'button quiet'}
            title={WAITING[checkpoint.id]?.() ?? checkpoint.description}
            onClick={sign}
          >
            <StampIcon aria-hidden="true" /> {t('Sign off {name}', { name })}
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="card checkpoint" data-state={state}>
      <div className="checkpoint-text">
        <strong>
          {state === 'signed' ? (
            <SealCheckIcon aria-hidden="true" />
          ) : (
            <StampIcon aria-hidden="true" />
          )}{' '}
          {t('Checkpoint: {name}', { name })}
        </strong>
        <span className="muted">
          {state === 'signed'
            ? t('Signed off on {date}. The crew goes on from here.', {
                date: new Date(signedAt ?? '').toLocaleDateString(),
              })
            : state === 'waiting'
              ? (WAITING[checkpoint.id]?.() ?? checkpoint.description)
              : t('Your working style lets the crew go on without stopping here.')}
        </span>
      </div>
      {state === 'signed' ? (
        <button type="button" className="button quiet" onClick={reopen}>
          {t('Take back')}
        </button>
      ) : (
        <button
          type="button"
          className={state === 'waiting' ? 'button primary' : 'button'}
          onClick={sign}
        >
          <SealCheckIcon aria-hidden="true" /> {t('Sign off')}
        </button>
      )}
      {(live.error ?? error) !== null && (
        <p className="error" role="alert">
          {live.error ?? error}
        </p>
      )}
    </div>
  );
}

const STYLES: readonly { value: Checkpoints['style']; label: () => string }[] = [
  { value: 'each', label: () => t('Stop at each checkpoint for me') },
  { value: 'main', label: () => t('Stop only at the storyboard') },
  { value: 'none', label: () => t('Make it all on its own') },
];

/**
 * How much the crew does on its own in the project: whether it stops at each
 * checkpoint, only at the storyboard, or works through. Spending still keeps
 * to the budget either way.
 */
export function WorkingStyleField({ project }: { project: Project }): ReactElement | null {
  const live = useCheckpoints(project);
  const { run, error } = useRun(project);
  const id = useId();
  if (live.data === undefined) return null;
  return (
    <div className="stack working-style">
      <label htmlFor={id}>
        <strong>{t('How much the crew does on its own')}</strong>
      </label>
      <select
        id={id}
        value={live.data.style}
        onChange={(event) => {
          run('project.checkpoint.style', { style: event.target.value });
        }}
      >
        {STYLES.map((style) => (
          <option key={style.value} value={style.value}>
            {style.label()}
          </option>
        ))}
      </select>
      <span className="muted">
        {t(
          'The crew stops at checkpoints for you to look before the next, more expensive step: the treatment, the storyboard of each scene and its first cut. Spending always keeps to the budget.',
        )}
      </span>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
