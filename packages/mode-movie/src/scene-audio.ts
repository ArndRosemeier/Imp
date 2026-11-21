import { SoundPlacement, Track, type AudioLink, type LengthOf, snapSeconds } from '@imp/audio';
import { CommandError, type CoreRuntime, type KeyValueStore } from '@imp/core';
import { characterPrefix, editHistoryKey, editKey, shotPrefix, soundPrefix } from './commands.js';
import { itemTimes, itemsOf, readCut, requireScene, save } from './edit.js';
import type { CutItem, CutLine } from './schema.js';
import { Character, CutHistory, SceneCut, Shot, Sound } from './schema.js';

/**
 * The tracks a scene's sound is shown on in the audio editor. The Edit stage
 * keeps one audio lane; here each kind of sound gets a track of its own.
 */
const TRACKS = [
  { id: 'dialogue', name: 'Dialogue' },
  { id: 'clip', name: 'Clip sound' },
  { id: 'effects', name: 'Effects' },
  { id: 'music', name: 'Music' },
] as const;
type TrackId = (typeof TRACKS)[number]['id'];

/** Characters with a lane of their own (a narrator, say) get a track each, holding their lines. */
const LANE = 'lane-';
const LINE = 'line-';

/** Regions that stand for the sound an item plays with its picture, not a placement of the lane. */
const ATTACHED = { dialogue: 'item-dialogue-', clip: 'item-clip-' } as const;

const ID = 'audio.doc.open';

async function scenePieces(store: KeyValueStore, projectId: string, sceneId: string) {
  const shots = new Map<string, Shot>();
  for (const entry of await store.list(shotPrefix(projectId))) {
    const shot = Shot.parse(entry.value);
    shots.set(shot.id, shot);
  }
  const sounds = new Map(
    (await store.list(soundPrefix(projectId, sceneId))).map((entry) => {
      const sound = Sound.parse(entry.value);
      return [sound.id, sound] as const;
    }),
  );
  return { shots, sounds };
}

type Pieces = Awaited<ReturnType<typeof scenePieces>>;

/** The stored file a placement plays, and the track it shows on. */
function placementFile(placement: SoundPlacement, pieces: Pieces) {
  const shot = pieces.shots.get(placement.shotId);
  if (placement.source === 'dialogue') {
    return { key: shot?.dialogue?.blobKey ?? '', track: 'dialogue' as TrackId };
  }
  if (placement.source === 'clip') {
    return { key: shot?.clip?.blobKey ?? '', track: 'clip' as TrackId };
  }
  const sound = pieces.sounds.get(placement.soundId);
  return {
    key: sound?.take?.blobKey ?? '',
    track: (sound?.kind === 'music' ? 'music' : 'effects') as TrackId,
  };
}

function labelOf(placement: SoundPlacement, pieces: Pieces): string {
  if (placement.label !== '') return placement.label;
  const shot = pieces.shots.get(placement.shotId);
  if (placement.source === 'dialogue') {
    return `Shot ${String(shot?.position ?? '?')}: ${shot?.line ?? ''}`.slice(0, 120);
  }
  if (placement.source === 'clip') return `Shot ${String(shot?.position ?? '?')} sound`;
  const sound = pieces.sounds.get(placement.soundId);
  return sound === undefined || sound.name === ''
    ? sound?.kind === 'music'
      ? 'Music'
      : 'Sound effect'
    : sound.name;
}

/** The scene's sound as tracks, every region with a length so that edits can reason about it. */
async function readScene(
  runtime: CoreRuntime,
  projectId: string,
  sceneId: string,
  lengthOf: LengthOf,
) {
  const scene = await requireScene(runtime.store, ID, projectId, sceneId);
  const cut = await readCut(runtime.store, projectId, sceneId);
  const items = await itemsOf(runtime.store, projectId, cut);
  const laid = await itemTimes(runtime.store, projectId, items);
  const pieces = await scenePieces(runtime.store, projectId, sceneId);
  const regions = new Map<TrackId, SoundPlacement[]>(TRACKS.map((track) => [track.id, []]));

  // The sound items play with their picture: recorded dialogue over a silent clip, or the clip's own.
  for (const [index, item] of items.entries()) {
    const at = laid.items[index];
    const shot = pieces.shots.get(item.shotId);
    if (item.kind !== 'shot' || at === undefined || at.durationSeconds <= 0 || shot === undefined) {
      continue;
    }
    const attached = (
      track: 'dialogue' | 'clip',
      key: string,
      length: number | null,
      volume: number,
    ) => {
      if (key === '' || volume <= 0) return;
      const available = length === null ? at.durationSeconds : length - item.trimStartSeconds;
      const duration = Math.min(at.durationSeconds, available);
      if (duration <= 0) return;
      regions.get(track)?.push(
        SoundPlacement.parse({
          id: `${ATTACHED[track]}${item.id}`,
          source: track,
          sceneId: item.sceneId,
          shotId: item.shotId,
          soundId: '',
          blobKey: key,
          label:
            track === 'dialogue'
              ? `Shot ${String(shot.position)}: ${shot.line}`.slice(0, 120)
              : `Shot ${String(shot.position)} sound`,
          trimStartSeconds: item.trimStartSeconds,
          startSeconds: at.startsAtSeconds,
          durationSeconds: snapSeconds(duration),
          volume,
          fadeInSeconds: 0,
          fadeOutSeconds: 0,
          loop: false,
        }),
      );
    };
    if (shot.clip?.silent === true && shot.dialogue !== null) {
      attached(
        'dialogue',
        shot.dialogue.blobKey,
        shot.dialogue.durationSeconds,
        item.dialogueVolume,
      );
    }
    if (shot.clip?.status === 'ready' && !shot.clip.silent) {
      attached('clip', shot.clip.blobKey ?? '', shot.clip.durationSeconds, item.clipAudioVolume);
    }
  }

  // The placements of the lane, each on the track of its kind.
  for (const placement of cut.sounds) {
    if (placement.source === 'file') continue;
    const { key, track } = placementFile(placement, pieces);
    let duration = placement.durationSeconds;
    if (duration === null) {
      const length = key === '' ? undefined : await lengthOf(key);
      duration = placement.loop
        ? Math.max(0.01, laid.totalSeconds - placement.startSeconds)
        : Math.max(0.01, (length ?? 0.01) - placement.trimStartSeconds);
    }
    regions.get(track)?.push(
      SoundPlacement.parse({
        ...placement,
        blobKey: key,
        label: labelOf(placement, pieces),
        durationSeconds: snapSeconds(duration),
      }),
    );
  }

  // Each character with a lane of their own, with their recorded lines.
  const cast = (await runtime.store.list(characterPrefix(projectId))).map((entry) =>
    Character.parse(entry.value),
  );
  const lanes = cast.filter((character) =>
    character.ownLane ? true : cut.lines.some((line) => line.characterId === character.id),
  );
  const lineLengths = new Map<string, number>();
  const laneTracks = [];
  for (const character of lanes) {
    const lines = [];
    for (const line of cut.lines) {
      if (line.characterId !== character.id || line.take === null) continue;
      const length = line.take.durationSeconds ?? (await lengthOf(line.take.blobKey)) ?? 0.01;
      lineLengths.set(line.id, length);
      lines.push(
        SoundPlacement.parse({
          id: `${LINE}${line.id}`,
          source: 'file',
          blobKey: line.take.blobKey,
          label: line.text.slice(0, 120),
          soundId: '',
          trimStartSeconds: line.trimStartSeconds,
          startSeconds: line.startSeconds,
          durationSeconds: snapSeconds(Math.max(0.01, length - line.trimStartSeconds)),
          volume: line.volume,
          fadeInSeconds: line.fadeInSeconds,
          fadeOutSeconds: line.fadeOutSeconds,
          loop: false,
          effects: line.effects,
        }),
      );
    }
    laneTracks.push(
      Track.parse({
        id: `${LANE}${character.id}`,
        name: character.name.slice(0, 80),
        regions: lines.sort((a, b) => a.startSeconds - b.startSeconds),
      }),
    );
  }

  return {
    name: `Scene ${String(scene.position)}: ${scene.heading}`.slice(0, 120),
    tracks: [
      ...TRACKS.map((track) =>
        Track.parse({
          id: track.id,
          name: track.name,
          regions: (regions.get(track.id) ?? []).sort((a, b) => a.startSeconds - b.startSeconds),
        }),
      ),
      ...laneTracks,
    ],
    cut,
    items,
    pieces,
    lineLengths,
  };
}

const same = (a: SoundPlacement, b: SoundPlacement): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** What a file placed from elsewhere is in this film, if it is one of its sounds. */
function adopt(region: SoundPlacement, pieces: Pieces, sceneId: string): SoundPlacement {
  for (const sound of pieces.sounds.values()) {
    if (sound.take?.blobKey === region.blobKey) {
      return { ...region, source: 'sound', soundId: sound.id, sceneId: '', shotId: '' };
    }
  }
  for (const shot of pieces.shots.values()) {
    if (shot.dialogue?.blobKey === region.blobKey) {
      return { ...region, source: 'dialogue', soundId: '', sceneId: shot.sceneId, shotId: shot.id };
    }
  }
  throw new CommandError(
    'invalid_input',
    ID,
    `A scene plays only its own sounds and recorded dialogue, and "${region.label || region.blobKey}" is neither. Add it as a sound of scene ${sceneId} first.`,
  );
}

/**
 * The sound lanes of a scene's cut as an audio document. Edits go back into
 * the cut and into its undo history, so the Edit stage and the audio editor
 * undo the same steps. Changing the sound an item plays with its picture
 * (anything but its volume) takes that sound apart from the picture first, as
 * movie.edit.audio.detach does.
 */
export function createSceneAudioLink(): AudioLink {
  return {
    kind: 'scene',
    target:
      'a scene id from movie.scene.list; its dialogue, clip sound, effects and music become tracks',
    read: async (runtime, projectId, sceneId, lengthOf) => {
      const { name, tracks } = await readScene(runtime, projectId, sceneId, lengthOf);
      return { name, tracks };
    },
    write: async (runtime, projectId, sceneId, tracks, lengthOf) => {
      const fresh = await readScene(runtime, projectId, sceneId, lengthOf);
      for (const track of tracks) {
        const fixed =
          TRACKS.some((candidate) => candidate.id === track.id) ||
          fresh.tracks.some((candidate) => candidate.id === track.id);
        if (!fixed || track.gainDb !== 0 || track.pan !== 0) {
          throw new CommandError(
            'invalid_input',
            ID,
            "A scene's tracks are its kinds of sound and play at their own level; set gain, volume and pan on the regions instead.",
          );
        }
      }
      const before = new Map(
        fresh.tracks.flatMap((track) => track.regions).map((region) => [region.id, region]),
      );
      const stored = new Map(fresh.cut.sounds.map((placement) => [placement.id, placement]));
      const items: CutItem[] = fresh.items.map((item) => ({ ...item }));
      const itemOf = (id: string) => items.find((item) => item.id === id);
      const sounds: SoundPlacement[] = [];
      const seen = new Set<string>();

      const lines: CutLine[] = [];
      for (const track of tracks) {
        if (!track.id.startsWith(LANE)) continue;
        for (const region of track.regions) {
          seen.add(region.id);
          const line = fresh.cut.lines.find((candidate) => `${LINE}${candidate.id}` === region.id);
          const length = line === undefined ? undefined : fresh.lineLengths.get(line.id);
          const plays = length === undefined ? 0 : length - region.trimStartSeconds;
          if (line === undefined || Math.abs((region.durationSeconds ?? plays) - plays) > 0.002) {
            throw new CommandError(
              'invalid_input',
              ID,
              "A character's line plays to its end: move it, trim its start, fade or level it, or remove it, but split or shorten it on the Edit stage by recording it again.",
            );
          }
          lines.push({
            ...line,
            startSeconds: region.startSeconds,
            trimStartSeconds: region.trimStartSeconds,
            volume: region.volume,
            fadeInSeconds: region.fadeInSeconds,
            fadeOutSeconds: region.fadeOutSeconds,
            effects: region.effects,
          });
        }
      }
      // Lines not yet recorded are not shown, and stay.
      lines.push(...fresh.cut.lines.filter((line) => line.take === null));

      for (const region of tracks.filter((t) => !t.id.startsWith(LANE)).flatMap((t) => t.regions)) {
        seen.add(region.id);
        const old = before.get(region.id);
        const kind = region.id.startsWith(ATTACHED.dialogue)
          ? 'dialogue'
          : region.id.startsWith(ATTACHED.clip)
            ? 'clip'
            : null;
        if (kind !== null && old !== undefined) {
          const item = itemOf(region.id.slice(ATTACHED[kind].length));
          if (item === undefined) continue;
          if (same({ ...old, volume: region.volume }, region)) {
            if (kind === 'dialogue') item.dialogueVolume = region.volume;
            else item.clipAudioVolume = region.volume;
            continue;
          }
          // Moved, trimmed, faded or split: it becomes a placement of its own.
          if (kind === 'dialogue') item.dialogueVolume = 0;
          else item.clipAudioVolume = 0;
          sounds.push({ ...region, id: runtime.newId(), blobKey: '', label: '' });
          continue;
        }
        const original = stored.get(region.id);
        if (original !== undefined && old !== undefined && same(old, region)) {
          sounds.push(original);
          continue;
        }
        const placed = region.source === 'file' ? adopt(region, fresh.pieces, sceneId) : region;
        sounds.push(
          SoundPlacement.parse({
            ...placed,
            blobKey: '',
            label:
              placed.label === labelOf({ ...placed, label: '' }, fresh.pieces) ? '' : placed.label,
          }),
        );
      }
      // What was taken out is no longer heard.
      for (const id of before.keys()) {
        if (seen.has(id)) continue;
        for (const kind of ['dialogue', 'clip'] as const) {
          if (!id.startsWith(ATTACHED[kind])) continue;
          const item = itemOf(id.slice(ATTACHED[kind].length));
          if (item === undefined) continue;
          if (kind === 'dialogue') item.dialogueVolume = 0;
          else item.clipAudioVolume = 0;
        }
      }
      // Placements the editor does not show (stored files) stay.
      sounds.push(...fresh.cut.sounds.filter((placement) => placement.source === 'file'));
      const itemsChanged = JSON.stringify(items) !== JSON.stringify(fresh.items);
      const after = SceneCut.parse({
        ...fresh.cut,
        items: itemsChanged || fresh.cut.items !== null ? items : null,
        sounds,
        // In the order they were, so that an untouched cut stays the same.
        lines: fresh.cut.lines.flatMap((line) => lines.filter((kept) => kept.id === line.id)),
      });
      await save(runtime, projectId, fresh.cut, after);
    },
    travel: async (runtime, projectId, sceneId, direction) => {
      await requireScene(runtime.store, ID, projectId, sceneId);
      const cut = await readCut(runtime.store, projectId, sceneId);
      const key = editHistoryKey(projectId, sceneId);
      const history = CutHistory.parse((await runtime.store.get(key)) ?? {});
      const from = direction === 'undo' ? history.undo : history.redo;
      const target = from.at(-1);
      if (target === undefined) return false;
      const rest = from.slice(0, -1);
      const other = [...(direction === 'undo' ? history.redo : history.undo), cut];
      await runtime.store.batch([
        { type: 'put', key: editKey(projectId, sceneId), value: target },
        {
          type: 'put',
          key,
          value: direction === 'undo' ? { undo: rest, redo: other } : { undo: other, redo: rest },
        },
      ]);
      return true;
    },
    steps: async (runtime, projectId, sceneId) => {
      await requireScene(runtime.store, ID, projectId, sceneId);
      const history = CutHistory.parse(
        (await runtime.store.get(editHistoryKey(projectId, sceneId))) ?? {},
      );
      return { undo: history.undo.length, redo: history.redo.length };
    },
  };
}
