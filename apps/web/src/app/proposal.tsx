import { CheckIcon, SparkleIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';
import { clock, type Change, type Cut, type Proposal } from './cut-player.js';

/** The crew, by id, so that a proposal can say who made it. */
function useCrewNames(): ReadonlyMap<string, string> {
  const crew = useLive(['crew/'], async (imp) =>
    z
      .object({ crew: z.array(z.object({ id: z.string(), name: z.string() })) })
      .parse(await runCommand(imp, 'crew.list', {})),
  );
  return new Map((crew.data?.crew ?? []).map((member) => [member.id, member.name]));
}

const KIND_TEXT: Record<Change['kind'], string> = {
  added: 'New',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
};

const span = (from: number | null, to: number | null): string =>
  from === null || to === null ? 'the whole scene' : `${clock(from)}–${clock(to)}`;

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
  const who =
    draft.authors.map((author) => names.get(author.id) ?? author.role).join(' and ') ||
    'Nobody yet';
  const count = draft.changes;
  return (
    <section className="proposal" aria-label="Proposed changes">
      <SparkleIcon aria-hidden="true" className="proposal-icon" />
      <div className="proposal-text">
        <strong>
          {count === 0
            ? who === 'Nobody yet'
              ? 'Waiting for the crew'
              : `${who} is working`
            : `${who} proposes ${String(count)} ${count === 1 ? 'change' : 'changes'}`}
        </strong>
        {draft.request !== null && (
          <span className="muted">
            “{draft.request.instruction}” on{' '}
            {span(draft.request.fromSeconds, draft.request.toSeconds)}
          </span>
        )}
      </div>
      <div className="segmented" role="group" aria-label="Version shown">
        <button
          type="button"
          aria-pressed={version === 'cut'}
          onClick={() => {
            onVersion('cut');
          }}
        >
          Cut
        </button>
        <button
          type="button"
          aria-pressed={version === 'draft'}
          onClick={() => {
            onVersion('draft');
          }}
        >
          Proposal
        </button>
      </div>
      <button className="button primary small" disabled={count === 0} onClick={onKeepAll}>
        <CheckIcon aria-hidden="true" /> Keep all
      </button>
      <button className="button quiet small" onClick={onDiscard}>
        <XIcon aria-hidden="true" /> Discard
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
      <h3>Proposed changes</h3>
      <p className="muted small">
        Play the proposal to judge it. Keep what works, reject what does not; keeping is one step
        that Undo takes back.
        {proposal?.cutChanged === true &&
          ' The cut changed since the work began: kept changes are laid onto it as it is now.'}
      </p>
      {changes.length === 0 && <p className="muted">Nothing is changed yet.</p>}
      <ol className="changes">
        {changes.map((change) => (
          <li key={change.id} className="change" data-kind={change.kind}>
            <button
              type="button"
              className="change-body"
              onClick={() => {
                onFocus(change);
              }}
              title="Show it on the timeline"
            >
              <span className="change-kind">{KIND_TEXT[change.kind]}</span>
              <span>{change.summary}</span>
              {change.conflict && (
                <span className="change-flag">
                  <WarningIcon aria-hidden="true" /> You changed this too; keeping replaces your
                  change.
                </span>
              )}
              {change.outside && (
                <span className="change-flag">Outside the stretch you asked about.</span>
              )}
            </button>
            <span className="change-actions">
              <button
                type="button"
                className="button quiet icon"
                aria-label={`Keep: ${change.summary}`}
                title="Keep"
                onClick={() => {
                  onKeep(change.id);
                }}
              >
                <CheckIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="button quiet icon"
                aria-label={`Reject: ${change.summary}`}
                title="Reject"
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
