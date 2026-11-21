/**
 * Frames of a clip in any order: forwards as a stream, backwards in short
 * runs. A decoder only moves forwards, from a key frame; asking it for frames
 * one by one going back would decode a whole stretch for every frame. So a
 * backwards run is read forwards a few frames at a time and shown in reverse,
 * which keeps few decoded frames in memory at once. A frame asked for twice
 * in a row (slow motion, a held frame) is decoded once and shown again.
 */

/** How many frames of a backwards run are decoded at once. */
export const BACKWARDS_RUN = 12;

/**
 * Calls show with the frame at each of times, in their order. read gives the
 * frames at times that rise, one for each (null where there is none); close
 * frees a frame once it is shown for the last time.
 */
export async function inOrder<T extends object>(
  times: readonly number[],
  read: (rising: readonly number[]) => AsyncIterable<T | null>,
  close: (frame: T) => void,
  show: (frame: T | null) => Promise<void>,
): Promise<void> {
  let at = 0;
  while (at < times.length) {
    const first = times[at] ?? 0;
    const next = times[at + 1];
    const backwards = next !== undefined && next < first;
    let end = at + 1;
    if (backwards) {
      while (
        end < times.length &&
        end - at < BACKWARDS_RUN &&
        (times[end] ?? 0) <= (times[end - 1] ?? 0)
      ) {
        end++;
      }
    } else {
      while (end < times.length && (times[end] ?? 0) >= (times[end - 1] ?? 0)) end++;
    }
    const run = times.slice(at, end);
    const rising = [...new Set(run)].sort((a, b) => a - b);
    if (backwards) {
      // Read the run forwards, keep it, show it backwards, then free it.
      const frames = new Map<number, T | null>();
      let index = 0;
      for await (const frame of read(rising)) {
        const time = rising[index++];
        if (time !== undefined) frames.set(time, frame);
      }
      for (const time of run) await show(frames.get(time) ?? null);
      const freed = new Set<T>();
      for (const frame of frames.values()) {
        if (frame !== null && !freed.has(frame)) {
          freed.add(frame);
          close(frame);
        }
      }
    } else {
      const iterator = read(rising)[Symbol.asyncIterator]();
      let shown: T | null = null;
      let current: number | undefined;
      try {
        for (const time of run) {
          if (time !== current) {
            const result = await iterator.next();
            const frame = result.done === true ? null : result.value;
            // The same frame may come for neighbouring times; free a frame only once it is replaced.
            if (shown !== null && shown !== frame) close(shown);
            shown = frame;
            current = time;
          }
          await show(shown);
        }
      } finally {
        if (shown !== null) close(shown);
        await iterator.return?.();
      }
    }
    at = end;
  }
}
