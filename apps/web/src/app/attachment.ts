import { useSyncExternalStore } from 'react';

/**
 * A stretch of a scene the person marked on the Edit stage, attached to what
 * they next say to the crew: the message becomes a request about that
 * stretch (movie.edit.request), and the agent is told where to look.
 */
export interface EditAttachment {
  /** How the chip names it: "Scene 2 · 0:04–0:10". */
  readonly label: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly fromSeconds: number;
  readonly toSeconds: number;
}

let current: EditAttachment | null = null;
const listeners = new Set<() => void>();

export function setAttachment(next: EditAttachment | null): void {
  const same =
    next === current ||
    (next !== null &&
      current !== null &&
      next.label === current.label &&
      next.sceneId === current.sceneId &&
      next.fromSeconds === current.fromSeconds &&
      next.toSeconds === current.toSeconds);
  if (same) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getAttachment(): EditAttachment | null {
  return current;
}

export function useAttachment(): EditAttachment | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}
