/**
 * Frames of a clip in any order: forwards as a stream, backwards in short
 * runs. A decoder only moves forwards, from a key frame; asking it for frames
 * one by one going back would decode a whole stretch for every frame. So a
 * backwards run is read forwards a few frames at a time and given out in
 * reverse, which keeps few decoded frames in memory at once. A frame asked for
 * twice in a row (slow motion, a held frame) is decoded once and given again.
 */

/** How many frames of a backwards run are decoded at once. */
export const BACKWARDS_RUN = 12;

/** Splits times into runs: rising runs whole, falling runs a few frames long. */
function runsOf(times: readonly number[]): { run: number[]; backwards: boolean }[] {
  const runs: { run: number[]; backwards: boolean }[] = [];
  let at = 0;
  while (at < times.length) {
    const first = times[at] ?? 0;
    const next = times[at + 1];
    const backwards = next !== undefined && next < first;
    let end = at + 1;
    const goesOn = (index: number): boolean =>
      backwards
        ? index - at < BACKWARDS_RUN && (times[index] ?? 0) <= (times[index - 1] ?? 0)
        : (times[index] ?? 0) >= (times[index - 1] ?? 0);
    while (end < times.length && goesOn(end)) end++;
    runs.push({ run: times.slice(at, end), backwards });
    at = end;
  }
  return runs;
}

/**
 * The frame at each of times, in their order. read gives the frames at times
 * that rise, one for each (null where there is none); close frees a frame.
 * A frame given out stays usable until the next one is asked for, so two
 * clips can be read side by side (for a dissolve) with one generator each.
 */
export async function* framesInOrder<T extends object>(
  times: readonly number[],
  read: (rising: readonly number[]) => AsyncIterable<T | null>,
  close: (frame: T) => void,
): AsyncGenerator<T | null, void, undefined> {
  for (const { run, backwards } of runsOf(times)) {
    const rising = [...new Set(run)].sort((a, b) => a - b);
    if (backwards) {
      // Read the run forwards, keep it, give it out backwards, then free it.
      const frames = new Map<number, T | null>();
      let index = 0;
      for await (const frame of read(rising)) {
        const time = rising[index++];
        if (time !== undefined) frames.set(time, frame);
      }
      try {
        for (const time of run) yield frames.get(time) ?? null;
      } finally {
        const freed = new Set<T>();
        for (const frame of frames.values()) {
          if (frame !== null && !freed.has(frame)) {
            freed.add(frame);
            close(frame);
          }
        }
      }
      continue;
    }
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
        yield shown;
      }
    } finally {
      if (shown !== null) close(shown);
      await iterator.return?.();
    }
  }
}
