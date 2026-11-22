import { XIcon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from '../context.js';
import { openHelp, stageHintId, TopicListing, useHelpState } from './help.js';
import { GuideTopic } from '@imp/core';
import { ImpMark } from '../ImpMark.js';
import { t } from '../../i18n/i18n.js';

/** Stages that are full-screen editors: their tip keeps to one line, so the editor keeps its room. */
const COMPACT = new Set(['edit', 'audio']);

/**
 * The tip shown the first time a stage opens: what the stage is for and what
 * to do first. "Got it" closes this one; "Turn off all tips" closes every tip
 * for good in one step, for people who know their way around.
 */
export function StageTip({ stage }: { stage: string }): ReactElement | null {
  const imp = useImp();
  const help = useHelpState();
  const id = stageHintId(stage);
  const show = help.data !== undefined && help.data.enabled && !help.data.dismissed.includes(id);
  const topic = useLive([`help-stage:${show ? stage : ''}`], async (current) => {
    if (!show) return null;
    const { topics } = z
      .object({ topics: z.array(TopicListing) })
      .parse(await runCommand(current, 'help.topics', { area: stage }));
    const first = topics[0];
    return first === undefined
      ? null
      : GuideTopic.parse(await runCommand(current, 'help.topic', { id: first.id }));
  });
  const page = topic.data;
  if (!show || page?.hint === undefined) return null;

  const run = (command: string, input: unknown): void => {
    runCommand(imp, command, input).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  };
  return (
    <aside
      className="stage-tip"
      data-compact={COMPACT.has(stage) ? 'true' : undefined}
      aria-label={t('Tip: {title}', { title: page.hint.title })}
    >
      {/* Tips come from the imp, so they carry its mark. */}
      <span className="stage-tip-icon">
        <ImpMark height={26} />
      </span>
      <div className="stage-tip-text">
        <strong>{page.hint.title}</strong>
        <p title={page.hint.body}>{page.hint.body}</p>
        <div className="stage-tip-actions">
          <button
            className="button primary small"
            onClick={() => {
              run('help.hint.dismiss', { id });
            }}
          >
            {t('Got it')}
          </button>
          <button
            className="button quiet small"
            onClick={() => {
              openHelp(page.id);
            }}
          >
            {t('Read more')}
          </button>
          <button
            className="button quiet small"
            onClick={() => {
              run('help.set', { enabled: false });
            }}
          >
            {t('Turn off all tips')}
          </button>
        </div>
      </div>
      <button
        className="button quiet icon stage-tip-close"
        aria-label={t('Close this tip')}
        onClick={() => {
          run('help.hint.dismiss', { id });
        }}
      >
        <XIcon aria-hidden="true" size={16} />
      </button>
    </aside>
  );
}
