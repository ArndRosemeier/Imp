import type { Project } from '@imp/core';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { ImpSpinner } from './ImpMark.js';
import { moviePrefix } from './movie.js';
import { t, tn } from '../i18n/i18n.js';

/** How often a clip that is being made is looked at again. */
export const CHECK_EVERY_MS = 10_000;

const PendingList = z.object({
  clips: z.array(
    z.object({
      sceneId: z.string(),
      scenePosition: z.number(),
      sceneHeading: z.string(),
      shotId: z.string(),
      shotPosition: z.number(),
      model: z.string(),
      createdAt: z.string(),
      progress: z.number().nullable(),
    }),
  ),
});
export type PendingClip = z.infer<typeof PendingList>['clips'][number];

interface PendingClips {
  readonly clips: readonly PendingClip[];
  /** The last failed check of a clip, by shot id, while it keeps being tried. */
  readonly problems: ReadonlyMap<string, string>;
}

const EMPTY: PendingClips = { clips: [], problems: new Map() };
const PendingContext = createContext<PendingClips>(EMPTY);

/**
 * Watches every clip of the open project that is being made, whichever stage
 * is shown, and checks on each until it is ready or has failed. Clips that an
 * agent started are picked up too, and so are clips left pending by a reload.
 */
export function PendingClipsProvider({
  project,
  children,
}: {
  project: Project | null;
  children: ReactNode;
}): ReactElement {
  const imp = useImp();
  const movie = project !== null && project.mode === 'movie';
  const prefix = project === null ? 'none/' : `${moviePrefix(project)}shots/`;
  const listed = useLive([prefix], async (current) =>
    movie
      ? PendingList.parse(
          await runCommand(current, 'movie.shot.clip.pending', { projectId: project.id }),
        ).clips
      : [],
  );
  const clips = useMemo(() => listed.data ?? [], [listed.data]);
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const waiting = clips.map((clip) => `${clip.sceneId}:${clip.shotId}`).join(',');

  useEffect(() => {
    if (waiting === '' || project === null) return undefined;
    let active = true;
    const check = (): void => {
      for (const entry of waiting.split(',')) {
        const [sceneId, shotId] = entry.split(':') as [string, string];
        runCommand(imp, 'movie.shot.clip.check', { projectId: project.id, sceneId, shotId }).then(
          () => {
            if (!active) return;
            setProblems((before) => {
              if (!before.has(shotId)) return before;
              const next = new Map(before);
              next.delete(shotId);
              return next;
            });
          },
          (error: unknown) => {
            if (!active) return;
            setProblems((before) => new Map(before).set(shotId, messageOf(error)));
          },
        );
      }
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [imp, project, waiting]);

  const value = useMemo(() => ({ clips, problems }), [clips, problems]);
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>;
}

export function usePendingClips(): PendingClips {
  return useContext(PendingContext);
}

/** A small "Rendering" badge with the spinner, for a shot or a scene whose clip is being made. */
export function RenderingBadge({
  count,
  progress = null,
  compact = false,
}: {
  /** How many clips are being made, when it is more than the one shot. */
  count?: number;
  progress?: number | null;
  /** Only the spinner and the count, for tight places such as a scene tab. */
  compact?: boolean;
}): ReactElement {
  const words =
    count === undefined
      ? t('Rendering')
      : tn(count, '{count} clip rendering', '{count} clips rendering');
  const percent = progress === null ? '' : ` ${String(Math.round(progress))}%`;
  return (
    <span
      className={`rendering-badge${compact ? ' compact' : ''}`}
      role="status"
      title={`${words}${percent}`}
      aria-label={`${words}${percent}`}
    >
      <ImpSpinner size={compact ? 12 : 14} />
      {compact ? (
        count === undefined || count < 2 ? null : (
          <span>{count}</span>
        )
      ) : (
        <span>
          {words}
          {percent}
        </span>
      )}
    </span>
  );
}
