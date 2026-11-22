import { GuideTopic, HelpState } from '@imp/core';
import { z } from 'zod';
import { runCommand, useLive, type Live } from '../context.js';

export const TopicListing = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  area: z.string(),
});
export type TopicListing = z.infer<typeof TopicListing>;
const TopicList = z.object({ topics: z.array(TopicListing) });

/** The event any view sends to open the help panel, optionally at one page. */
export const OPEN_HELP = 'imp:open-help';

export function openHelp(topicId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_HELP, { detail: topicId ?? null }));
}

/** The event that puts words in the coordinator's message box, for the person to send. */
export const ASK_COORDINATOR = 'imp:ask-coordinator';

/** Opens the coordinator with `text` ready to send. Nothing is sent: the person reads it and presses Send. */
export function askCoordinator(text: string): void {
  window.dispatchEvent(new CustomEvent(ASK_COORDINATOR, { detail: text }));
}

/** Whether tips are shown and which are closed. Settings, so it follows agents' changes too. */
export function useHelpState(): Live<HelpState> {
  return useLive(['settings/'], async (imp) =>
    HelpState.parse(await runCommand(imp, 'help.state', {})),
  );
}

export function useTopics(query: string): Live<TopicListing[]> {
  // The guide is fixed for a build, so the query is the only thing that changes what is listed.
  return useLive([`help-query:${query}`], async (imp) => {
    const input = query.trim() === '' ? {} : { query: query.trim() };
    return TopicList.parse(await runCommand(imp, 'help.topics', input)).topics;
  });
}

export function useTopic(id: string | null): Live<GuideTopic | null> {
  return useLive([`help-topic:${id ?? ''}`], async (imp) =>
    id === null ? null : GuideTopic.parse(await runCommand(imp, 'help.topic', { id })),
  );
}

/** The id of the first-time tip of a stage. */
export function stageHintId(stage: string): string {
  return `stage.${stage}`;
}
