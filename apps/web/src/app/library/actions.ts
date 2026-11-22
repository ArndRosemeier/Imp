import type { Project } from '@imp/core';
import type { ImpClient } from '@imp/host';
import { WaveformIcon, type Icon } from '@phosphor-icons/react';
import { z } from 'zod';
import { runCommand } from '../context.js';
import { openWhereMade, type Asset } from './model.js';
import { t } from '../../i18n/i18n.js';

export interface ActionContext {
  readonly imp: ImpClient;
  readonly project: Project;
}

/**
 * Something an asset can be used for besides being dropped somewhere, shown
 * on the asset in the library. Every action runs commands, so an agent can do
 * the same with the asset's blobKey.
 */
export interface LibraryAction {
  readonly id: string;
  readonly label: string;
  readonly icon: Icon;
  readonly appliesTo: (asset: Asset) => boolean;
  readonly run: (asset: Asset, context: ActionContext) => Promise<void>;
}

const actions = new Map<string, LibraryAction>();

/** Adds an action to every asset it applies to. Registering an id again replaces it. */
export function registerLibraryAction(action: LibraryAction): void {
  actions.set(action.id, action);
}

export function actionsFor(asset: Asset): LibraryAction[] {
  return [...actions.values()].filter((action) => action.appliesTo(asset));
}

const Created = z.object({ document: z.object({ id: z.string() }) });

/** Where the Audio stage remembers its open document; it follows this when focused. */
export const audioDocSetting = (projectId: string): string => `imp.audio.doc.${projectId}`;

registerLibraryAction({
  id: 'audio.open',
  get label(): string {
    return t('Open in audio editor');
  },
  icon: WaveformIcon,
  appliesTo: (asset) => asset.modality === 'sound' && asset.blobKey !== null,
  run: async (asset, { imp, project }) => {
    const output = await runCommand(imp, 'audio.doc.create', {
      projectId: project.id,
      name: asset.title.slice(0, 120) || t('Untitled sound'),
      sources: [{ key: asset.blobKey, label: asset.title.slice(0, 120) }],
    });
    const docId = Created.parse(output).document.id;
    try {
      localStorage.setItem(audioDocSetting(project.id), docId);
    } catch {
      // The focus event below opens it too.
    }
    openWhereMade({ view: 'audio', focus: { docId } });
  },
});
