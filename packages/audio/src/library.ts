import { projectPrefix, readProject, type LibrarySource, type SourceAsset } from '@imp/core';
import { AudioDoc, docDuration } from './doc.js';

/**
 * The audio editor's documents, for the library. Mic recordings join them
 * here as kind "recording" once they exist.
 */
export const audioLibrarySource: LibrarySource = {
  id: 'audio',
  kinds: [
    { id: 'audio-doc', modality: 'sound', label: 'Audio document', plural: 'Audio documents' },
  ],
  list: async ({ store }, projectId) => {
    if ((await readProject(store, projectId)) === undefined) return [];
    const docs = (await store.list(`${projectPrefix(projectId)}audio/docs/`)).flatMap((entry) => {
      const parsed = AudioDoc.safeParse(entry.value);
      return parsed.success ? [parsed.data] : [];
    });
    return docs.map((doc): SourceAsset => ({
      id: `audio:audio-doc:${doc.id}`,
      modality: 'sound',
      kind: 'audio-doc',
      title: doc.name,
      context: doc.link === null ? `${String(doc.tracks.length)} tracks` : 'Scene sound',
      origin: 'edited',
      durationSeconds: Math.round(docDuration(doc) * 1000) / 1000 || null,
      createdAt: doc.updatedAt,
      open: { view: 'audio', focus: { docId: doc.id } },
      refs: { docId: doc.id },
    }));
  },
};
