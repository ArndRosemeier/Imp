import { CheckIcon, SparkleIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { clock, type Change, type Cut, type Proposal } from './cut-player.js';
import { t, tn, tx } from '../i18n/i18n.js';

/** The crew, by id, so that a proposal can say who made it. */
function useCrewNames(): ReadonlyMap<string, string> {
  const crew = useLive(['crew/'], async (imp) =>
    z
      .object({ crew: z.array(z.object({ id: z.string(), name: z.string() })) })
      .parse(await runCommand(imp, 'crew.list', {})),
  );
  return new Map((crew.data?.crew ?? []).map((member) => [member.id, tx(member.name)]));
}

const KIND_TEXT: Record<Change['kind'], string> = {
  get added(): string {
    return t('New');
  },
  get removed(): string {
    return t('Removed');
  },
  get changed(): string {
    return t('Changed');
  },
  get moved(): string {
    return t('Moved');
  },
};

const span = (from: number | null, to: number | null): string =>
  from === null || to === null ? t('the whole scene') : `${clock(from)}–${clock(to)}`;

/**
 * What agents propose for this scene, above the timeline: who, on what
 * request, how many changes, and the switch between the cut and the proposal.
 */
export function ProposalBar({
  draft,
  version,
  onVersion,
  onKeepAll,
  onDiscard,
}: {
  draft: NonNullable<Cut['draft']>;
  version: 'cut' | 'draft';
  onVersion: (version: 'cut' | 'draft') => void;
  onKeepAll: () => void;
  onDiscard: () => void;
}): ReactElement {
  const names = useCrewNames();
  const authors = draft.authors.map((author) => names.get(author.id) ?? tx(author.role));
  const who =
    authors.length <= 1
      ? (authors[0] ?? '')
      : t('{names} and {last}', {
          names: authors.slice(0, -1).join(', '),
          last: authors.at(-1) ?? '',
        });
  const count = draft.changes;
  return (
    <section className="proposal" aria-label={t('Proposed changes')}>
      <SparkleIcon aria-hidden="true" className="proposal-icon" />
      <div className="proposal-text">
        <strong>
          {count === 0
            ? authors.length === 0
              ? t('Waiting for the crew')
              : t('{who} is working', { who })
            : tn(count, '{who} proposes {count} change', '{who} proposes {count} changes', {
                who,
              })}
        </strong>
        {draft.request !== null && (
          <span className="muted">
            {t('“{instruction}” on {fromSeconds}', {
              instruction: draft.request.instruction,
              fromSeconds: span(draft.request.fromSeconds, draft.request.toSeconds),
            })}
          </span>
        )}
      </div>
      <div className="segmented" role="group" aria-label={t('Version shown')}>
        <button
          type="button"
          aria-pressed={version === 'cut'}
          onClick={() => {
            onVersion('cut');
          }}
        >
          {t('Cut')}
        </button>
        <button
          type="button"
          aria-pressed={version === 'draft'}
          onClick={() => {
            onVersion('draft');
          }}
        >
          {t('Proposal')}
        </button>
      </div>
      <button className="button primary small" disabled={count === 0} onClick={onKeepAll}>
        <CheckIcon aria-hidden="true" /> {t('Keep all')}
      </button>
      <button className="button quiet small" onClick={onDiscard}>
        <XIcon aria-hidden="true" /> {t('Discard')}
      </button>
    </section>
  );
}

/** The proposed changes one by one, each to keep or reject, in place of the inspector. */
export function ChangeList({
  proposal,
  onKeep,
  onReject,
  onFocus,
}: {
  proposal: Proposal | undefined;
  onKeep: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onFocus: (change: Change) => void;
}): ReactElement {
  const changes = proposal?.changes ?? [];
  return (
    <div className="stack change-list">
      <h3>{t('Proposed changes')}</h3>
      <p className="muted small">
        {t(
          'Play the proposal to judge it. Keep what works, reject what does not; keeping is one step that Undo takes back.',
        )}
        {proposal?.cutChanged === true &&
          t(' The cut changed since the work began: kept changes are laid onto it as it is now.')}
      </p>
      {changes.length === 0 && <p className="muted">{t('Nothing is changed yet.')}</p>}
      <ol className="changes">
        {changes.map((change) => (
          <li key={change.id} className="change" data-kind={change.kind}>
            <button
              type="button"
              className="change-body"
              onClick={() => {
                onFocus(change);
              }}
              title={t('Show it on the timeline')}
            >
              <span className="change-kind">{KIND_TEXT[change.kind]}</span>
              <span>{change.summary}</span>
              {change.conflict && (
                <span className="change-flag">
                  <WarningIcon aria-hidden="true" />{' '}
                  {t('You changed this too; keeping replaces your change.')}
                </span>
              )}
              {change.outside && (
                <span className="change-flag">{t('Outside the stretch you asked about.')}</span>
              )}
            </button>
            <span className="change-actions">
              <button
                type="button"
                className="button quiet icon"
                aria-label={t('Keep: {summary}', { summary: change.summary })}
                title={t('Keep')}
                onClick={() => {
                  onKeep(change.id);
                }}
              >
                <CheckIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="button quiet icon"
                aria-label={t('Reject: {summary}', { summary: change.summary })}
                title={t('Reject')}
                onClick={() => {
                  onReject(change.id);
                }}
              >
                <XIcon aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
