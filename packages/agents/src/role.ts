import type { KeyValueStore, ToolScope } from '@imp/core';
import { z } from 'zod';

/**
 * A job an agent can be hired for. Modes contribute roles; the user or the
 * coordinator hires a crew member into one.
 */
export interface Role {
  /** Lower-case and dashed: `screenwriter`, `casting-director`. */
  readonly id: string;
  readonly name: string;
  /** One line shown when choosing whom to hire. */
  readonly summary: string;
  /** The standing instructions the agent works under. */
  readonly brief: string;
  /** The commands this role may call. An agent cannot act outside it. */
  readonly scope: ToolScope;
  /**
   * Prefixes of the commands handed to the model as tools from the start.
   * Everything else in scope stays reachable, but the agent looks it up when
   * it needs it, so a wide scope does not cost context on every request.
   * Left out, every command in scope is a tool.
   */
  readonly direct?: readonly string[];
  /** Whether agents hired for this role can search the web unless the hire says otherwise. */
  readonly webSearch?: boolean;
  /**
   * An extra: built in, but not among the roles offered for hire until a
   * person or the coordinator adds it (crew.role.add), so the default crew
   * stays small. A critic is one.
   */
  readonly optional?: boolean;
}

export const ROLE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Where the roles defined while using the app are kept, by role id. */
export const CUSTOM_ROLE_PREFIX = 'roles/';

/** Which extra built-in roles were added to the ones offered for hire, by role id. */
export const ADDED_ROLE_PREFIX = 'roles-added/';

/** Where the crew is kept; an extra role someone holds counts as added. */
const CREW_PREFIX = 'crew/';

/** A role as stored data. Built-in roles come from code and are never stored. */
export const StoredRole = z.object({
  id: z.string().regex(ROLE_ID),
  name: z.string().min(1),
  summary: z.string(),
  brief: z.string().min(1),
  scope: z.object({
    effects: z.array(z.enum(['read', 'write', 'spend', 'destructive'])).min(1),
    prefixes: z.array(z.string().min(1)).min(1),
  }),
  webSearch: z.boolean().default(false),
});
export type StoredRole = z.infer<typeof StoredRole>;

function toRole(stored: StoredRole): Role {
  return {
    id: stored.id,
    name: stored.name,
    summary: stored.summary,
    brief: stored.brief,
    scope: { prefixes: stored.scope.prefixes, effects: stored.scope.effects },
    webSearch: stored.webSearch,
  };
}

/**
 * The roles available for hire: the ones the enabled modes contribute, fixed
 * at start-up, plus the ones people or agents define while using the app.
 */
export class RoleCatalog {
  readonly #roles = new Map<string, Role>();

  constructor(roles: readonly Role[] = []) {
    for (const role of roles) {
      if (!ROLE_ID.test(role.id)) {
        throw new TypeError(`Invalid role id: "${role.id}"`);
      }
      if (this.#roles.has(role.id)) {
        throw new TypeError(`Role "${role.id}" is defined twice.`);
      }
      this.#roles.set(role.id, role);
    }
  }

  get(id: string): Role | undefined {
    return this.#roles.get(id);
  }

  list(): readonly Role[] {
    return [...this.#roles.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** A built-in role, or one defined while using the app. Built-in ones win. */
  async find(store: KeyValueStore, id: string): Promise<Role | undefined> {
    const builtIn = this.#roles.get(id);
    if (builtIn !== undefined) return builtIn;
    const stored = await store.get(`${CUSTOM_ROLE_PREFIX}${id}`);
    return stored === undefined ? undefined : toRole(StoredRole.parse(stored));
  }

  /** The extra roles that are offered for hire: added, or held by someone on the crew. */
  async #addedIds(store: KeyValueStore): Promise<Set<string>> {
    const added = new Set(
      (await store.list(ADDED_ROLE_PREFIX)).map((entry) =>
        entry.key.slice(ADDED_ROLE_PREFIX.length),
      ),
    );
    for (const entry of await store.list(CREW_PREFIX)) {
      const roleId = (entry.value as { roleId?: unknown } | null)?.roleId;
      if (typeof roleId === 'string') added.add(roleId);
    }
    return added;
  }

  /**
   * Every role that can be hired for, sorted by id, with whether it is a
   * custom one. Extra roles count only once added.
   */
  async all(store: KeyValueStore): Promise<readonly (Role & { readonly custom: boolean })[]> {
    const custom = (await store.list(CUSTOM_ROLE_PREFIX))
      .map((entry) => toRole(StoredRole.parse(entry.value)))
      .filter((role) => !this.#roles.has(role.id));
    const added = await this.#addedIds(store);
    return [
      ...this.list()
        .filter((role) => role.optional !== true || added.has(role.id))
        .map((role) => ({ ...role, custom: false })),
      ...custom.map((role) => ({ ...role, custom: true })),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The extra roles not added yet, which crew.role.add can offer for hire. */
  async extras(store: KeyValueStore): Promise<readonly Role[]> {
    const added = await this.#addedIds(store);
    return this.list().filter((role) => role.optional === true && !added.has(role.id));
  }
}

/**
 * The agent the user talks to. It has no mechanism of its own: it plans and
 * delegates through the same commands a person uses. It reads and writes
 * freely, may ask to spend, and cannot destroy.
 */
export const coordinatorRole: Role = {
  id: 'coordinator',
  name: 'Coordinator',
  summary: 'Talks with you, plans the work, hires the crew and keeps things moving.',
  brief: [
    'You are the coordinator of this workspace. The user tells you what they want to make.',
    'Work out what is needed, look at the current state with the read tools, and carry out',
    'setup and organisation yourself: adjust settings, pick models from models.list (never',
    'guess a model id), see which roles exist, and hire crew',
    'members for the work. Give specialised work to the crew member whose role it is with',
    'crew.ask, in one task that says everything they need, and pass on what they report.',
    "Giving a task costs money. Paid steps run without asking until the project's budget the",
    'user set is used up (spend.allowance.get); after that they are put to the user. To change',
    'the budget, run spend.allowance.set: the user is asked to approve it every time.',
    "Prefer doing over asking, and ask only when a choice is truly the user's. When the user",
    'asks you to make something by yourself, such as a whole film from one prompt, carry on to',
    'the end without stopping to ask about steps that fit the budget: do them and say what',
    'they cost. Crew members are told the open project; open or create the project first.',
    "Put the user's own words about how the work should look and feel into every task you",
    'give, and before pictures are made check that the project keeps the same style (for a',
    'film, the tone in its development, which every picture is drawn in); if it does not, set',
    'it right yourself first. Be brief and concrete.',
    'When the user asks how Imp works, read the guide (help.topics, help.topic) instead of',
    'guessing, and before spending say what it will cost (spend.estimate).',
    'Imp keeps reusable things of its own, shared by every project: saved crews',
    '(crew.saved.*, the Crews tab of the library; they keep each agent with model, budget and',
    'web search, plus copies of their custom roles, and load again with crew.saved.load),',
    'model mixes (models.mix.*, the Mixes tab and the Models chip) and project templates',
    '(project.template.*, which keep a project but not its crew). When the user wants to keep',
    'or reuse a crew or a set of models, save it there, never as a text note.',
    'Before you say Imp cannot do something, look it up with find_commands: anything the',
    'user can do in the app, you can do with a command.',
  ].join(' '),
  // Spending and deleting are in scope so that they can be asked for; the policy still puts
  // them to the user. Anything the person can do, the coordinator can ask to do.
  scope: { effects: ['read', 'write', 'spend', 'destructive'] },
  direct: ['crew.', 'project.', 'settings.', 'models.', 'help.'],
};

/**
 * Ask Imp: the help that is always there. It explains the app from its own
 * guide and can do a step for the person through the same commands they
 * use. Like every agent it asks before spending or deleting.
 */
export const guideRole: Role = {
  id: 'guide',
  name: 'Imp',
  summary: 'Answers questions about Imp and does a step for you when you ask.',
  brief: [
    'You are Imp, the help built into the Imp app, which makes films with AI-generated',
    'pictures, voices, sound and video. People ask you how something works, what to do next,',
    'or to do a step for them.',
    'For any question about the app, search the guide first (help.topics with a query, then',
    'help.topic) and answer from it in a few plain sentences, naming the stage and the button',
    'to use. Never invent a feature: if neither the guide nor the commands show it, say that',
    'Imp cannot do it yet.',
    'When the person asks you to do something, do it with the same commands they would use',
    '(find them with find_commands, look at the project with the read commands first), then',
    'say what you did and where to see it. Before anything that costs money, say what it will',
    'cost (spend.estimate for a command, spend.quote for a kind of work such as "a 4 second',
    'clip"); the person is asked to approve spending and deleting. What was spent so far is',
    'in spend.summary.',
    'For large creative work, such as writing a whole script or casting a film, suggest the',
    'coordinator, who hires the right crew. People who want no tips can turn them all off',
    'with help.set. For a newcomer, project.path says which step of a first film comes next.',
    'Crews and model mixes can be saved and loaded in any project (crew.saved.*, models.mix.*;',
    'the Crews and Mixes tabs of the library). Anything the person can do in the app has a',
    'command, so look with find_commands before you say something is not possible.',
    'When something looks broken, ask what happened, then write a report with',
    'support.report.prepare; a button for it appears in this chat, so point to the button',
    'instead of pasting the long link, which gets cut. They check and submit it on GitHub.',
    'Answer in the language the person writes in.',
    'Your manner is a friendly imp: warm, quick and to the point, with at most one light touch',
    'of wit per answer. Clarity always comes first; keep jokes out of prices, errors and problem',
    'reports, and drop them entirely when the person sounds stuck or annoyed.',
  ].join(' '),
  scope: { effects: ['read', 'write', 'spend', 'destructive'] },
  direct: ['help.', 'spend.', 'settings.', 'project.', 'support.'],
};
