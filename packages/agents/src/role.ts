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
   * and the coordinator judges it from what it reads. Before a command it is
   * given the command's input, so that a need can hold for one part of the
   * project only, such as one scene.
   */
  readonly check?: (store: KeyValueStore, projectId: string, input?: unknown) => Promise<boolean>;
  /**
   * Provided by the person alone, such as their sign-off of a checkpoint: no
   * role makes it, and no agent can waive it or give a task without it.
   */
  readonly byPerson?: boolean;
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
  /**
   * Work outside the role's scope that another agent does, with what to tell
   * the agent when it tries: a project's coordinator passes what concerns all
   * projects to the Imp coordinator. `writes` names commands that change
   * something, `prefixes` any command.
   */
  readonly passOn?: {
    readonly writes?: readonly string[];
    readonly prefixes?: readonly string[];
    readonly note: string;
  };
}

/** What a role is told when it tries `command` outside its scope, or null. */
export function passOnNote(role: Role, command: Command): string | null {
  const pass = role.passOn;
  if (pass === undefined) return null;
  const matches = (prefixes: readonly string[] | undefined) =>
    prefixes?.some((prefix) => command.id.startsWith(prefix)) === true;
  if (matches(pass.prefixes)) return pass.note;
  if (command.effect !== 'read' && matches(pass.writes)) return pass.note;
  return null;
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
 * What a project's coordinator changes itself: the crew's work in the open
 * project and what belongs to it. The work of a mode (a script, a cast, a
 * clip) belongs to the crew member whose role it is, so the coordinator gives
 * it to them instead of doing it, and needs nothing but text to coordinate.
 * What concerns every project (settings, models, saved crews, custom roles,
 * creating, copying, opening or deleting projects, backups) is the Imp
 * coordinator's, to whom it passes such asks.
 */
export const COORDINATOR_WRITES: readonly string[] = [
  'crew.ask',
  'crew.hire',
  'crew.update',
  'crew.dismiss',
  'crew.needs',
  'crew.conversation.',
  'crew.work.',
  'project.rename',
  'project.export',
  'project.checkpoint.',
  'project.resources.',
  'spend.',
  'help.hint.',
  'library.',
  'support.',
];

/**
 * What the Imp coordinator changes: everything that concerns all projects.
 * It never does the work inside a project; it hands that to the project's
 * coordinator.
 */
export const GLOBAL_COORDINATOR_WRITES: readonly string[] = [
  'crew.',
  'project.',
  'settings.',
  'models.',
  'spend.',
  'help.',
  'library.',
  'backup.',
  'support.',
  'system.',
];

/** The commands that concern all projects, which a project's coordinator passes on. */
export const GLOBAL_ONLY_WRITES: readonly string[] = [
  'crew.role.',
  'crew.saved.',
  'project.create',
  'project.delete',
  'project.duplicate',
  'project.import',
  'project.open',
  'project.template.',
  'settings.',
  'models.',
  'help.set',
  'backup.',
  'system.',
];

/**
 * What the Imp coordinator reads: the workspace and the projects as a whole,
 * never the work inside one, which is the project coordinator's to look at.
 */
const GLOBAL_COORDINATOR_READS: readonly string[] = [
  ...GLOBAL_COORDINATOR_WRITES,
  'app.',
  'activity.',
];

/** The role of the coordinator for all projects, of which a workspace has one. */
export const GLOBAL_COORDINATOR_ROLE = 'global-coordinator';

/**
 * Who a message in the Imp coordinator's chat was passed on from, as the
 * first line of the message's context: `Passed on by the coordinator of the
 * project "<name>" (projectId "<id>").` The chat shows it as a note.
 */
export const PASSED_ON = 'Passed on by the coordinator of the project ';

/** The project a message was passed on from, read from its context, or null. */
export function passedOnFrom(context: string | undefined): { name: string; id: string } | null {
  if (context?.startsWith(PASSED_ON) !== true) return null;
  const match = /^(".*") \(projectId "([^"]+)"\)\.$/.exec(
    context.slice(PASSED_ON.length).split('\n')[0] ?? '',
  );
  if (match === null) return null;
  try {
    const name = JSON.parse(match[1] ?? '') as unknown;
    return typeof name === 'string' ? { name, id: match[2] ?? '' } : null;
  } catch {
    return null;
  }
}

/** The context line that marks a message passed on from a project. */
export function passedOnLine(project: { name: string; id: string }): string {
  return `${PASSED_ON}${JSON.stringify(project.name)} (projectId "${project.id}").`;
}

/**
 * The agent the user talks to about one project. It has no mechanism of its
 * own: it plans and delegates through the same commands a person uses. It
 * reads everything, hires and directs the crew, may ask to spend, leaves the
 * work itself to the crew, and passes what concerns all projects to the Imp
 * coordinator.
 */
export const coordinatorRole: Role = {
  id: 'coordinator',
  name: 'Coordinator',
  summary:
    'Talks with you about a project, plans the work, hires the crew and keeps things moving.',
  brief: [
    'You are the coordinator of the open project. The user tells you what they want to make.',
    'You coordinate: you plan the work, set things up and give each piece of it to the crew',
    'member whose role it is. You do not do their work yourself; you cannot write scenes, make',
    'characters, places, shots or sounds, or edit, and you never need to see a picture or hear',
    'a sound, since judging them is the work of whoever made them. Look at the current state',
    'with the read tools, and hire crew members for the work, one per role the work needs,',
    'each on a model that fits its role (models.list with role lists only those: a role that',
    'judges pictures needs a model that sees them, while a writer works with any; never guess',
    'a model id).',
    'What concerns all projects is not yours to change: settings and the models Imp uses,',
    'model mixes, saved crews, custom roles, creating, copying, opening, importing or deleting',
    'projects, templates and backups. Pass such an ask on to the Imp coordinator, who works for',
    'all projects, with crew.ask (its member id is in your context), in one task that says',
    "everything, including the user's words; then tell the user it was passed to the Imp",
    'coordinator and what came back. Do the rest of the work yourself as usual.',
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
    'A project being created or opened is not a request to make anything: start work only when',
    'the user asks for it, and when they have not said what they want, ask. Work stage by stage',
    'and stop at the checkpoints (project.checkpoint.list): for a film, the treatment, the',
    'storyboard of each scene and the first cut of each scene. At a checkpoint, show the user',
    'what was made, briefly, and ask them to sign it off with project.checkpoint.approve (it',
    'is put in front of them); what waits for it cannot start before. The working style says',
    'where the crew stops: "each" checkpoint (the default), only the "main" one, or "none".',
    'When the user asks you to make something by yourself, such as a whole film from one',
    'prompt, ask to change the working style once with project.checkpoint.style, then carry on',
    'up to the next checkpoint that still stops, without asking about steps that fit the',
    'budget. Within a stage, prefer doing over asking, and ask only when a choice is truly the',
    "user's. Ask for only what the work needs: clips come with their own sound, so give the",
    'Sound Designer work only when the user asks for music or sound, or the first cut shows a',
    'scene lacks it. Crew members are told the open project.',
    "Put the user's own words about how the work should look and feel into every task you",
    'give, and before pictures are made check that the project keeps the same style (for a',
    'film, the tone in its development, which every picture is drawn in); if it does not, have',
    'the one who writes it set it right first. Be brief and concrete.',
    'When the user asks how Imp works, read the guide (help.topics, help.topic) instead of',
    'guessing, and before spending say what it will cost (spend.estimate).',
    'Before you say Imp cannot do something, look it up with find_commands: anything the',
    'user can do in the app, you, a crew member or the Imp coordinator can do with a command.',
  ].join(' '),
  // Spending and deleting are in scope so that they can be asked for; the policy still puts
  // them to the user. It reads everything; it changes only what is its own to change.
  scope: { effects: ['read', 'write', 'spend', 'destructive'], writes: COORDINATOR_WRITES },
  // It coordinates in words, so a model that takes only text is enough.
  sees: [],
  direct: ['crew.', 'project.', 'models.list', 'help.'],
  passOn: {
    writes: GLOBAL_ONLY_WRITES,
    note: "This concerns all projects, so it is the Imp coordinator's to do. Pass the ask on to it with crew.ask (its member id is in your context), then tell the user it was passed on.",
  },
};

/**
 * The coordinator for all projects, which the user talks to on the start
 * screen and under "All projects": settings, models, saved crews, custom
 * roles, the library across projects, and creating, copying, opening or
 * deleting projects. It talks in one chat of its own, whatever project is
 * open, and hands the work inside a project to that project's coordinator.
 */
export const globalCoordinatorRole: Role = {
  id: GLOBAL_COORDINATOR_ROLE,
  name: 'Imp coordinator',
  summary: 'Looks after everything that concerns all projects: settings, models, crews, projects.',
  brief: [
    'You are the Imp coordinator: you look after what concerns all projects of this Imp, not',
    'the work inside one. That is the settings and the models Imp uses (pick them from',
    'models.list, never guess an id), model mixes (models.mix.*), the crew and the roles',
    '(crew.hire, crew.role.*), saved crews (crew.saved.*), the library across projects,',
    'creating, copying, opening, importing, exporting and deleting projects, templates',
    '(project.template.*), backups and problem reports. Each project has a coordinator of its',
    'own for its work, and they pass you what concerns all projects: such a message says which',
    'project it comes from. Do what it asks and reply with what you did, briefly, for that',
    'coordinator to tell the user.',
    'You do not do the work inside a project (writing, casting, shots, sound, editing) and you',
    'cannot change it. Creating a project is only that: when the user asks for a project,',
    'create it, open it and tell them it is ready, and ask what they want to do first; do not',
    'start work in it they did not ask for. When the user asks for something to be made in it,',
    "such as a film from a description, give that to the project's coordinator with crew.ask",
    "(its member id is in your context), in one task that carries the user's own words; it",
    'works with the crew there and stops at the checkpoints for the user. Tell the user the',
    'project is open and its coordinator is on it.',
    'Prefer doing over asking. Deleting and spending are put to the user for approval; before',
    'spending say what it will cost (spend.estimate). When the user asks how Imp works, read',
    'the guide (help.topics, help.topic) instead of guessing. Before you say Imp cannot do',
    'something, look it up with find_commands. Be brief and concrete.',
  ].join(' '),
  scope: {
    effects: ['read', 'write', 'spend', 'destructive'],
    prefixes: GLOBAL_COORDINATOR_READS,
    writes: GLOBAL_COORDINATOR_WRITES,
  },
  sees: [],
  direct: ['crew.', 'project.', 'settings.', 'models.', 'help.'],
  passOn: {
    prefixes: [''],
    note: "This is work inside a project, which is the project's coordinator's to do. Open the project, then give the work to its coordinator with crew.ask (its member id is in your context).",
  },
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
