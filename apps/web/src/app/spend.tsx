import { CoinsIcon, XIcon } from '@phosphor-icons/react';
import { useRef, type ReactElement } from 'react';
import { z } from 'zod';
import { runCommand, useImp, useLive } from './context.js';
import { NumberField } from './NumberField.js';
import { currentLanguage, formatNumber, t } from '../i18n/i18n.js';
import { Marked } from '../i18n/Marked.js';

const Kind = z.enum(['chat', 'image', 'speech', 'sound', 'music', 'video', 'transcription']);
const Estimate = z.object({
  usd: z.number().nullable(),
  maxUsd: z.number().optional(),
  basis: z.enum(['price list', 'your history', 'typical', 'budget', 'unknown']),
  model: z.string().nullable(),
  kind: Kind,
});
export type Estimate = z.infer<typeof Estimate>;
const EstimateResult = z.object({ estimate: Estimate.nullable() });

const Totals = z.object({ usd: z.number(), calls: z.number() });
const Summary = z.object({
  today: Totals,
  project: Totals.extend({ projectId: z.string().nullable() }),
  all: Totals,
  estimatedUsd: z.number(),
  byKind: z.array(z.object({ kind: Kind, usd: z.number(), calls: z.number() })),
  latest: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      kind: Kind,
      model: z.string(),
      usd: z.number(),
      estimated: z.boolean(),
    }),
  ),
});

const AllowanceView = z.object({
  step: z.number(),
  project: z.number(),
  projectSpentUsd: z.number(),
  projectLeftUsd: z.number(),
});

/** What agents may spend without asking, set by the person and only by them. */
function AllowanceFields(): ReactElement | null {
  const imp = useImp();
  const allowance = useLive(['settings/', 'spend/'], async (current) =>
    AllowanceView.parse(await runCommand(current, 'spend.allowance.get', {})),
  );
  const data = allowance.data;
  if (data === undefined) return null;
  const set = (change: { step?: number; project?: number }): void => {
    runCommand(imp, 'spend.allowance.set', change).catch(() => undefined);
  };
  return (
    <section className="stack spend-allowance" aria-labelledby="spend-allowance">
      <h3 id="spend-allowance" className="eyebrow">
        {t('Budget without approval')}
      </h3>
      <div className="row">
        <NumberField
          label={t('Per project, $')}
          value={data.project}
          step={0.5}
          max={1000}
          onCommit={(project) => {
            set({ project });
          }}
        />
        <NumberField
          label={t('Most per step, $ (0: no limit)')}
          value={data.step}
          step={0.05}
          max={100}
          onCommit={(step) => {
            set({ step });
          }}
        />
      </div>
      <p className="spend-left">
        <Marked
          text={t('**{left}** left of {project}', {
            left: formatUsd(data.projectLeftUsd),
            project: formatUsd(data.project),
          })}
        />
        <span className="muted">
          {' '}
          {t('· {spent} spent here', { spent: formatUsd(data.projectSpentUsd) })}
        </span>
      </p>
      <p className="muted small">
        {t(
          'Agents spend without asking until this budget is used up; then every paid step asks again. Steps whose price is unknown still ask, and so does anything that deletes. Set the budget to 0 to approve every paid step yourself.',
        )}
      </p>
    </section>
  );
}

const KIND_NAMES: Readonly<Record<z.infer<typeof Kind>, string>> = {
  get chat(): string {
    return t('Agents');
  },
  get image(): string {
    return t('Pictures');
  },
  get speech(): string {
    return t('Voices');
  },
  get sound(): string {
    return t('Sound effects');
  },
  get music(): string {
    return t('Music');
  },
  get video(): string {
    return t('Video clips');
  },
  get transcription(): string {
    return t('Transcripts');
  },
};

/** Dollars as people read them: cents below a dollar keep two places, tiny amounts say so. */
export function formatUsd(usd: number, digits = 2): string {
  // US dollars, written the way the interface's language writes money: $0.25, or 0,25 $ in German.
  const money = (value: number): string =>
    formatNumber(value, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  if (usd > 0 && usd < 0.01) return `< ${money(0.01)}`;
  return money(usd);
}

/** The words for an estimate on a button: "≈ $0.20", "up to $0.50". Empty when nothing is known. */
export function priceLabel(estimate: Estimate | null | undefined): string {
  if (estimate === null || estimate === undefined) return '';
  if (estimate.basis === 'budget' && estimate.maxUsd !== undefined) {
    return t('up to {maxUsd}', { maxUsd: formatUsd(estimate.maxUsd) });
  }
  if (estimate.usd === null) return '';
  return `≈ ${formatUsd(estimate.usd)}`;
}

const BASIS: Readonly<Record<Estimate['basis'], string>> = {
  get 'price list'(): string {
    return t("from the model's price list");
  },
  get 'your history'(): string {
    return t('from what this model cost you before');
  },
  get typical(): string {
    return t('a rough typical price; it gets exact once this model has been used');
  },
  get budget(): string {
    return t("the agent's budget per run; a run usually costs less");
  },
  get unknown(): string {
    return t('no price is known');
  },
};

export function priceTitle(estimate: Estimate | null | undefined): string {
  if (estimate === null || estimate === undefined) return '';
  return `${priceLabel(estimate)}: ${BASIS[estimate.basis]}${estimate.model === null ? '' : ` (${estimate.model})`}.`;
}

/**
 * What running a command would cost, worked out by the core before it runs.
 * The open project is filled in, as the stages' own actions do.
 */
export function useEstimate(
  command: string,
  input: Readonly<Record<string, unknown>>,
): Estimate | null {
  const key = JSON.stringify(input);
  const live = useLive(['settings/', 'spend/', `estimate:${command}:${key}`], async (imp) => {
    const current = z
      .object({ value: z.json() })
      .parse(await runCommand(imp, 'settings.get', { key: 'project.current' })).value;
    const full = typeof current === 'string' ? { projectId: current, ...input } : input;
    return EstimateResult.parse(
      await runCommand(imp, 'spend.estimate', { commandId: command, input: full }),
    ).estimate;
  });
  return live.data ?? null;
}

/** The expected price inside a button that spends, such as "Generate clip ≈ $0.20". */
export function Price({
  command,
  input,
}: {
  command: string;
  input: Readonly<Record<string, unknown>>;
}): ReactElement | null {
  const estimate = useEstimate(command, input);
  const label = priceLabel(estimate);
  if (label === '') return null;
  return (
    <span className="price" title={priceTitle(estimate)} data-basis={estimate?.basis}>
      {label}
    </span>
  );
}

/** The running total in the top bar, and the breakdown it opens. */
export function SpendTotal(): ReactElement | null {
  const dialog = useRef<HTMLDialogElement>(null);
  const summary = useLive(['spend/', 'settings/project.current'], async (imp) =>
    Summary.parse(await runCommand(imp, 'spend.summary', { latest: 12 })),
  );
  const data = summary.data;
  if (data === undefined) return null;
  const shown = data.project.projectId === null ? data.all : data.project;
  return (
    <>
      <button
        className="button quiet spend-total"
        aria-haspopup="dialog"
        aria-label={
          data.project.projectId === null
            ? t('Spent {usd} in all. Show what was spent', { usd: formatUsd(shown.usd) })
            : t('Spent {usd} on this project. Show what was spent', { usd: formatUsd(shown.usd) })
        }
        title={t('What has been spent at OpenRouter')}
        onClick={() => dialog.current?.showModal()}
      >
        <CoinsIcon aria-hidden="true" size={18} />
        <span className="spend-amount">{formatUsd(shown.usd)}</span>
      </button>
      {/* A tap on the dimmed backdrop closes the panel, as Escape does; a tablet has no Escape key. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
      <dialog
        ref={dialog}
        className="modal spend-dialog"
        aria-labelledby="spend-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <header className="spend-head">
          <div className="stack">
            <span className="eyebrow">{t('Spending')}</span>
            <h2 id="spend-title">{t('What Imp has spent')}</h2>
          </div>
          <button
            className="button quiet icon"
            aria-label={t('Close')}
            onClick={() => dialog.current?.close()}
          >
            <XIcon aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="spend-body stack">
          <dl className="spend-totals">
            <div>
              <dt>{t('This project')}</dt>
              <dd>{formatUsd(data.project.usd)}</dd>
            </div>
            <div>
              <dt>{t('Today')}</dt>
              <dd>{formatUsd(data.today.usd)}</dd>
            </div>
            <div>
              <dt>{t('In all')}</dt>
              <dd>{formatUsd(data.all.usd)}</dd>
            </div>
          </dl>
          {data.byKind.length > 0 && (
            <section className="stack spend-kinds" aria-label={t('By kind')}>
              {data.byKind.map((kind) => (
                <div key={kind.kind} className="spend-kind">
                  <span>{KIND_NAMES[kind.kind]}</span>
                  <span
                    className="spend-bar"
                    aria-hidden="true"
                    style={{ width: `${String(Math.max(2, (kind.usd / data.all.usd) * 100))}%` }}
                  />
                  <span className="mono">
                    {formatUsd(kind.usd)} · {kind.calls}
                  </span>
                </div>
              ))}
            </section>
          )}
          {data.latest.length > 0 ? (
            <section className="stack" aria-labelledby="spend-latest">
              <h3 id="spend-latest" className="eyebrow">
                {t('Latest')}
              </h3>
              <ol className="spend-latest">
                {data.latest.map((entry) => (
                  <li key={entry.id}>
                    <span className="muted">
                      {new Date(entry.at).toLocaleTimeString(currentLanguage())}
                    </span>
                    <span>{KIND_NAMES[entry.kind]}</span>
                    <span className="mono muted spend-model">{entry.model}</span>
                    <span className="mono">
                      {entry.estimated ? '≈ ' : ''}
                      {formatUsd(entry.usd)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <p className="muted">{t('Nothing has been spent yet.')}</p>
          )}
          <AllowanceFields />
          <p className="muted small">
            {data.estimatedUsd > 0
              ? t(
                  'Imp itself is free; this is what OpenRouter charges your key. Amounts marked ≈ were not reported by the model and are estimates ({estimatedUsd} in all). Your OpenRouter account has the exact bill.',
                  { estimatedUsd: formatUsd(data.estimatedUsd) },
                )
              : t(
                  'Imp itself is free; this is what OpenRouter charges your key. Amounts marked ≈ were not reported by the model and are estimates. Your OpenRouter account has the exact bill.',
                )}
          </p>
        </div>
      </dialog>
    </>
  );
}
