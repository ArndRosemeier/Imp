import { projectPrefix, readProject, type LibrarySource, type SourceAsset } from '@imp/core';
import { AudioDoc, docDuration } from './doc.js';
import { recordingPrefix } from './record-commands.js';

/** The audio editor's documents and the microphone recordings, for the library. */
export const audioLibrarySource: LibrarySource = {
  id: 'audio',
  kinds: [
    { id: 'audio-doc', modality: 'sound', label: 'Audio document', plural: 'Audio documents' },
    { id: 'recording', modality: 'sound', label: 'Recording', plural: 'Recordings' },
  ],
  list: async ({ store, blobs }, projectId) => {
    if ((await readProject(store, projectId)) === undefined) return [];
    const docs = (await store.list(`${projectPrefix(projectId)}audio/docs/`)).flatMap((entry) => {
      const parsed = AudioDoc.safeParse(entry.value);
      return parsed.success ? [parsed.data] : [];
    });
    const documents = docs.map((doc): SourceAsset => ({
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
    // A recording is named by the region it was placed as, where one still plays it.
    const recordings = (await blobs.list(recordingPrefix(projectId)))
      .filter((key) => !key.includes('.audio/'))
      .map((key): SourceAsset => {
        const uses = docs.flatMap((doc) =>
          doc.tracks.flatMap((track) =>
            track.regions
              .filter((region) => region.blobKey === key)
              .map((region) => ({ doc, region })),
          ),
        );
        const first = uses[0];
        const id = key.slice(recordingPrefix(projectId).length).replace(/\.wav$/, '');
        const lengths = uses.map(
          ({ region }) => region.trimStartSeconds + (region.durationSeconds ?? 0),
        );
        return {
          id: `audio:recording:${id}`,
          modality: 'sound',
          kind: 'recording',
          title:
            first === undefined || first.region.label === '' ? 'Recording' : first.region.label,
          context: first === undefined ? 'Not placed' : first.doc.name,
          origin: 'imported',
          blobKey: key,
          mediaType: 'audio/wav',
          durationSeconds:
            lengths.length === 0 ? null : Math.round(Math.max(...lengths) * 1000) / 1000,
          createdAt: first?.doc.updatedAt ?? null,
          open: first === undefined ? null : { view: 'audio', focus: { docId: first.doc.id } },
          refs: first === undefined ? {} : { docId: first.doc.id, regionId: first.region.id },
        };
      });
    return [...documents, ...recordings];
  },
};
