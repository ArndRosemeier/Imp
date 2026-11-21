import { readProject, type LibrarySource, type SourceAsset } from '@imp/core';
import { readWorld } from './commands.js';
import type { WorldKind } from './schema.js';

const KIND_IDS: Readonly<Record<WorldKind, string>> = {
  location: 'location-view',
  object: 'object-view',
};

/** The pictures of the places and objects of a project, for the library. */
export const worldLibrarySource: LibrarySource = {
  id: 'world',
  kinds: [
    { id: 'location-view', modality: 'image', label: 'Location picture', plural: 'Locations' },
    { id: 'object-view', modality: 'image', label: 'Object picture', plural: 'Objects' },
  ],
  list: async ({ store }, projectId) => {
    if ((await readProject(store, projectId)) === undefined) return [];
    const assets: SourceAsset[] = [];
    for (const kind of ['location', 'object'] as const) {
      for (const element of await readWorld(store, projectId, kind)) {
        for (const image of element.images) {
          const view = element.views.find((candidate) => candidate.id === image.viewId);
          const state = element.states.find((candidate) => candidate.id === image.stateId);
          const isKey = element.keyImages.some(
            (key) =>
              key.imageId === image.id &&
              key.viewId === image.viewId &&
              key.stateId === image.stateId,
          );
          const angle = [view?.name, state?.name].filter((part) => part !== undefined).join(', ');
          assets.push({
            id: `world:${KIND_IDS[kind]}:${element.id}:${image.id}`,
            modality: 'image',
            kind: KIND_IDS[kind],
            title: `${element.name}${angle === '' ? '' : `, ${angle}`}`,
            context: isKey ? 'Chosen picture' : '',
            origin: 'generated',
            blobKey: image.blobKey,
            mediaType: image.mediaType,
            text: element.look,
            createdAt: image.createdAt,
            open: { view: 'design', focus: { kind, elementId: element.id } },
            refs: { kind, elementId: element.id, imageId: image.id, viewId: image.viewId },
          });
        }
      }
    }
    return assets;
  },
};
