import type {
  BlobStore,
  Command,
  GuideTopic,
  GuideTranslations,
  KeyValueStore,
  LibrarySource,
  ProjectSupport,
} from '@imp/core';
import type { Checkpoint } from './checkpoints.js';
import type { Role } from './role.js';
import type { WorkDescriber } from './work.js';

/** One step of a mode's workflow, shown in the navigation. Stages can be visited in any order. */
export interface Stage {
  readonly id: string;
  readonly name: string;
  /**
   * The guide's page about this stage, with the tip shown the first time it
   * opens. Its `area` must be the stage id.
   */
  readonly guide?: GuideTopic;
}

/**
 * A working mode: everything one kind of creation adds to Imp. The core, the
 * crew, approvals and the activity log know nothing about any particular mode,
 * so adding one means adding a package that exports one of these.
 */
export interface Mode {
  /** Lower-case; also the `mode` of the projects made in it and the prefix of its command ids. */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly stages: readonly Stage[];
  /** The stages' guide pages in other languages, with the same ids as the English ones. */
  readonly guideTranslations?: GuideTranslations;
  readonly commands: readonly Command[];
  readonly roles: readonly Role[];
  /** Templates, progress for the start screen, and what can be copied between projects. */
  readonly project?: ProjectSupport;
  /**
   * The visual style of a project in this mode, in words, for everything drawn
   * for it outside the mode, such as the pictures of its world.
   */
  readonly visualStyle?: (store: KeyValueStore, projectId: string) => Promise<string>;
  /** A picture of that style, which goes with the pictures of the world where a model takes one. */
  readonly visualReference?: (
    store: KeyValueStore,
    blobs: BlobStore,
    projectId: string,
  ) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string } | undefined>;
  /** What the mode brings to the library: the assets its projects make. */
  readonly library?: readonly LibrarySource[];
  /**
   * What the work board shows of this mode: the stage each command belongs
   * to, and names for the scenes, shots and others agents work on.
   */
  readonly work?: WorkDescriber;
  /**
   * Where the crew stops for the person to look before the next, more
   * expensive stage, in workflow order. Each sits on one of the stages.
   */
  readonly checkpoints?: readonly Checkpoint[];
}

/** Checks a mode's own consistency once, at start-up, instead of failing later in use. */
export function defineMode(mode: Mode): Mode {
  if (!/^[a-z][a-z0-9]*$/.test(mode.id)) {
    throw new TypeError(`Invalid mode id: "${mode.id}"`);
  }
  for (const stage of mode.stages) {
    if (stage.guide !== undefined && stage.guide.area !== stage.id) {
      throw new TypeError(`The guide page of stage "${stage.id}" must have area "${stage.id}".`);
    }
  }
  for (const command of mode.commands) {
    if (!command.id.startsWith(`${mode.id}.`)) {
      throw new TypeError(
        `Command "${command.id}" of mode "${mode.id}" must start with "${mode.id}.".`,
      );
    }
  }
  const stageIds = new Set(mode.stages.map((stage) => stage.id));
  if (stageIds.size !== mode.stages.length) {
    throw new TypeError(`Mode "${mode.id}" lists a stage twice.`);
  }
  for (const checkpoint of mode.checkpoints ?? []) {
    if (!stageIds.has(checkpoint.stage)) {
      throw new TypeError(
        `Checkpoint "${checkpoint.id}" of mode "${mode.id}" is on an unknown stage "${checkpoint.stage}".`,
      );
    }
  }
  return mode;
}
