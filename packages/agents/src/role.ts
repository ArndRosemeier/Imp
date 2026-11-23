import { isInScope, type Command, type KeyValueStore, type ToolScope } from '@imp/core';
import type { ModelInfo } from '@imp/providers';
import { z } from 'zod';

/**
 * Something a role needs before it can do its work, such as a cast before
 * the scenes are written. The coordinator checks a role's needs before it
 * gives the role a task and has whoever makes a missing piece make it first;
 * a crew member who finds something missing reports it instead of making it
 * up. Some projects go without a need (a film with no people needs no cast):
 * crew.needs.waive says so for one project.
 */
export interface Need {
  /** Shared by every role that needs the same thing, such as `cast`, so one waiver covers them. */
  readonly id: string;
  /** What is needed, in a few words: "A cast". */
  readonly name: string;
  /** What counts, and when it is needed, for whoever checks it. */
  readonly description: string;
  /** The role whose work provides it, when one does. */
  readonly providedBy?: string;
  /**
   * The commands it is needed for. While it is missing (and not waived) the
   * role cannot run them, and can do the rest of its work. Left out, the role
   * needs it for everything, and an agent is not given the role's work at all
   * until it is there.
   */
  readonly before?: readonly string[];
  /**
   * Whether the open project has it. Left out, it cannot be checked by Imp,
   * and the coordinator judges it from what it reads.
   */
  readonly check?: (store: KeyValueStore, projectId: string) => Promise<boolean>;
}

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
  /**
   * The commands this role may call. An agent cannot act outside it. Roles
   * read widely and write only in their own area (`writes`), so that each
   * piece of work is made by the role whose work it is.
   */
  readonly scope: ToolScope;
  /** What the role needs before it can work, which the coordinator arranges first. */
  readonly needs?: readonly Need[];
  /**
   * What the role is shown besides text, when its model takes it. Empty for
   * a role that works from text alone, so that a model that takes only text
   * is enough: it is never given a command that shows pictures, clips or
   * sound (media.view and the like). Left out, whatever its model takes.
   */
  readonly sees?: readonly SeenKind[];
  /**
   * What its model must take as input for the role to do its work at all,
   * such as pictures for a casting director who picks portraits. With tool
   * calling, this is what decides which models fit the role.
   */
  readonly mustSee?: readonly SeenKind[];
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

/** What an agent can be shown besides text. */
export const SEEN_KINDS = ['image', 'audio', 'video'] as const;
export type SeenKind = (typeof SEEN_KINDS)[number];

/** What a model needs to work in a role: tool calling always, and the input the role must see. */
export interface ModelNeeds {
  readonly tools: true;
  readonly input: readonly SeenKind[];
}

export function modelNeedsOf(role: Role): ModelNeeds {
  return { tools: true, input: [...(role.mustSee ?? [])] };
}

/** Why a model does not fit a role, in a sentence, or null when it fits. */
export function modelProblem(
  role: Role,
  model: Pick<ModelInfo, 'id' | 'inputModalities' | 'outputModalities' | 'supportsTools'>,
): string | null {
  if (!model.outputModalities.includes('text') || !model.supportsTools) {
    return `${model.id} cannot call tools, which every agent works with.`;
  }
  const missing = (role.mustSee ?? []).filter((kind) => !model.inputModalities.includes(kind));
  if (missing.length > 0) {
    const words: Record<SeenKind, string> = { image: 'pictures', audio: 'sound', video: 'video' };
    return `The ${role.name} needs a model that takes ${missing.map((kind) => words[kind]).join(' and ')} as input; ${model.id} does not.`;
  }
  return null;
}

/**
 * Whether a command shows the agent media: by the convention of media.view,
 * its result lists `attachments` that are put in front of the model.
 */
export function showsMedia(command: Command): boolean {
  const shape = (command.output as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && 'attachments' in shape;
}

/** Whether an agent in `role` may run `command`: in its scope, and no media for a role that sees none. */
export function roleCanUse(role: Role, command: Command): boolean {
  return isInScope(command, role.scope) && !(role.sees?.length === 0 && showsMedia(command));
}

export const ROLE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Where the roles defined while using the app are kept, by role id. */
export const CUSTOM_ROLE_PREFIX = 'roles/';

/** Which extra built-in roles were added to the ones offered for hire, by role id. */
export const ADDED_ROLE_PREFIX = 'roles-added/';

/** Where the crew is kept; an extra role someone holds counts as added. */
const CREW_PREFIX = 'crew/';

/** A need of a custom role: checked by the coordinator, since Imp has no code to check it. */
export const StoredNeed = z.object({
  id: z
    .string()
    .regex(ROLE_ID)
    .describe(
      'Short, lower-case and dashed, such as "cast"; the same id as other roles use for the same thing.',
    ),
  name: z.string().min(1).describe('What is needed, in a few words.'),
  description: z.string().default('').describe('What counts, and when it is needed.'),
  providedBy: z
    .string()
    .nullable()
    .default(null)
    .describe('The id of the role whose work provides it.'),
});
export type StoredNeed = z.infer<typeof StoredNeed>;

/** A role as stored data. Built-in roles come from code and are never stored. */
export const StoredRole = z.object({
  id: z.string().regex(ROLE_ID),
  name: z.string().min(1),
  summary: z.string(),
  brief: z.string().min(1),
  scope: z.object({
    effects: z.array(z.enum(['read', 'write', 'spend', 'destructive'])).min(1),
    prefixes: z.array(z.string().min(1)).min(1),
    /** Left out by roles stored before roles were kept to an area: they write wherever they read. */
    writes: z.array(z.string().min(1)).nullable().default(null),
  }),
  webSearch: z.boolean().default(false),
  needs: z.array(StoredNeed).default([]),
  /**
   * What the role is shown besides text, which its model must take. Null for
   * roles stored before roles said so: they are shown whatever their model takes.
   */
  sees: z.array(z.enum(SEEN_KINDS)).nullable().default(null),
});
export type StoredRole = z.infer<typeof StoredRole>;

function toRole(stored: StoredRole): Role {
  return {
    id: stored.id,
    name: stored.name,
    summary: stored.summary,
    brief: stored.brief,
    scope: {
      prefixes: stored.scope.prefixes,
      effects: stored.scope.effects,
      ...(stored.scope.writes === null ? {} : { writes: stored.scope.writes }),
    },
    webSearch: stored.webSearch,
    ...(stored.sees === null ? {} : { sees: stored.sees, mustSee: stored.sees }),
    needs: stored.needs.map(({ providedBy, ...need }) => ({
      ...need,
      ...(providedBy === null ? {} : { providedBy }),
    })),
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
 * What the coordinator changes itself: the workspace, the projects and the
 * crew. The work of a mode (a script, a cast, a clip) belongs to the crew
 * member whose role it is, so the coordinator gives it to them instead of
 * doing it, and needs nothing but text to coordinate.
 */
export const COORDINATOR_WRITES: readonly string[] = [
  'crew.',
  'project.',
  'settings.',
  'models.',
  'spend.',
  'help.',
  'library.',
  'backup.',
  'support.',
];

/**
 * The agent the user talks to. It has no mechanism of its own: it plans and
 * delegates through the same commands a person uses. It reads everything,
 * changes the workspace, the projects and the crew, may ask to spend, and
 * leaves the work itself to the crew.
 */
export const coordinatorRole: Role = {
  id: 'coordinator',
  name: 'Coordinator',
  summary: 'Talks with you, plans the work, hires the crew and keeps things moving.',
  brief: [
    'You are the coordinator of this workspace. The user tells you what they want to make.',
    'You coordinate: you plan the work, set things up and give each piece of it to the crew',
    'member whose role it is. You do not do their work yourself; you cannot write scenes, make',
    'characters, places, shots or sounds, or edit, and you never need to see a picture or hear',
    'a sound, since judging them is the work of whoever made them. Look at the current state',
    'with the read tools, and carry out setup and organisation yourself: adjust settings, pick',
    'models from models.list (never guess a model id), see which roles exist, and hire crew',
    'members for the work, one per role the work needs, each on a model that fits its role',
    '(models.list with role lists only those: a role that judges pictures needs a model that',
    'sees them, while a writer works with any).',
    'Work in order. Before you give a crew member a task, check what its role needs with',
    'crew.needs (for example the Screenwriter needs a cast before it writes scenes, and the',
    'Casting Director needs the development). When something is missing, first give the work',
    'that makes it to the role that provides it, then the task. When a task does not need a',
    'missing piece (the Screenwriter writing only the development), name it in without. When',
    'the project goes without it for good (a film with no characters needs no cast), say so',
    'once with crew.needs.waive. Give each task with crew.ask, in one task that says',
    'everything they need, and pass on what they report. A crew member that finds something',
    'missing stops with status blocked and says what (missing): arrange it, then ask them',
    'again, without a task, to continue.',
    "Giving a task costs money. Paid steps run without asking until the project's budget the",
    'user set is used up (spend.allowance.get); after that they are put to the user. To change',
    'the budget, run spend.allowance.set: the user is asked to approve it every time.',
    "Prefer doing over asking, and ask only when a choice is truly the user's. When the user",
    'asks you to make something by yourself, such as a whole film from one prompt, carry on to',
    'the end without stopping to ask about steps that fit the budget: do them and say what',
    'they cost. Crew members are told the open project; open or create the project first.',
    "Put the user's own words about how the work should look and feel into every task you",
    'give, and before pictures are made check that the project keeps the same style (for a',
    'film, the tone in its development, which every picture is drawn in); if it does not, have',
    'the one who writes it set it right first. Be brief and concrete.',
    'When the user asks how Imp works, read the guide (help.topics, help.topic) instead of',
    'guessing, and before spending say what it will cost (spend.estimate).',
    'Imp keeps reusable things of its own, shared by every project: saved crews',
    '(crew.saved.*, the Crews tab of the library; they keep each agent with model, budget and',
    'web search, plus copies of their custom roles, and load again with crew.saved.load),',
    'model mixes (models.mix.*, the Mixes tab and the Models chip) and project templates',
    '(project.template.*, which keep a project but not its crew). When the user wants to keep',
    'or reuse a crew or a set of models, save it there, never as a text note.',
    'When no role covers some work, create one with crew.role.create: give it only the',
    'commands of its own area to change (writes) and what it needs (needs).',
    'Before you say Imp cannot do something, look it up with find_commands: anything the',
    'user can do in the app, you or a crew member can do with a command.',
  ].join(' '),
  // Spending and deleting are in scope so that they can be asked for; the policy still puts
  // them to the user. It reads everything; it changes only what is its own to change.
  scope: { effects: ['read', 'write', 'spend', 'destructive'], writes: COORDINATOR_WRITES },
  // It coordinates in words, so a model that takes only text is enough.
  sees: [],
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
