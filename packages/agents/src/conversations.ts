import {
  CURRENT_PROJECT_SETTING,
  listProjects,
  projectPrefix,
  readProject,
  type KeyValueStore,
  type WriteOperation,
} from '@imp/core';

/**
 * Where conversations with crew members are kept.
 *
 * Each project has its own conversations, under the project, so a project's
 * copy, export, import and deletion take them along without knowing about
 * them. While no project is open (the start screen), agents talk in a
 * workspace-wide place of their own. The crew itself stays workspace-wide:
 * the same agents work on every project, they only remember each project
 * separately.
 */

/** Conversations held while no project is open, by member id. */
export const CONVERSATION_PREFIX = 'conversations/';

/** Set once the conversations of an Imp from before they were per project have been moved. */
export const CONVERSATION_MIGRATION_KEY = 'migrations/conversations-per-project';

/** Where the conversations of a project are kept, or the workspace-wide ones for null. */
export function conversationPrefix(projectId: string | null): string {
  return projectId === null ? CONVERSATION_PREFIX : `${projectPrefix(projectId)}conversations/`;
}

export function conversationKey(memberId: string, projectId: string | null): string {
  return `${conversationPrefix(projectId)}${memberId}`;
}

/** The open project whose conversations agents are in, or null when none is open. */
export async function currentConversationProject(store: KeyValueStore): Promise<string | null> {
  const current = await store.get(`settings/${CURRENT_PROJECT_SETTING}`);
  if (typeof current !== 'string') return null;
  return (await readProject(store, current)) === undefined ? null : current;
}

/** Every place conversations are kept: the workspace-wide one and one per project. */
export async function allConversationPrefixes(store: KeyValueStore): Promise<string[]> {
  const projects = await listProjects(store);
  return [conversationPrefix(null), ...projects.map((project) => conversationPrefix(project.id))];
}

/** Deletes that forget everything said with these members, in every project. */
export async function forgetConversations(
  store: KeyValueStore,
  memberIds: readonly string[],
): Promise<WriteOperation[]> {
  if (memberIds.length === 0) return [];
  const prefixes = await allConversationPrefixes(store);
  return prefixes.flatMap((prefix) =>
    memberIds.map((id) => ({ type: 'delete' as const, key: `${prefix}${id}` })),
  );
}
