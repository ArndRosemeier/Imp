import { ArrowClockwiseIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useState, type ReactElement } from 'react';
import { CHECK_EVERY_MS, fetchPublishedVersion, loadNewestVersion } from './updates.js';

/**
 * Tells the person when a newer Imp has been published while this one is open
 * or was opened from an old stored copy, with a button that loads it. It asks
 * when Imp starts, whenever Imp comes back to the screen, and every quarter
 * of an hour. Development and pull request builds never ask.
 */
export function UpdateNotice({
  running,
  check = fetchPublishedVersion,
}: {
  readonly running: string;
  readonly check?: (running: string) => Promise<string | null>;
}): ReactElement | null {
  const [newer, setNewer] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stopped = false;
    const ask = (): void => {
      if (document.visibilityState !== 'visible') return;
      check(running).then(
        (version) => {
          if (!stopped && version !== null) setNewer(version);
        },
        () => {
          // Offline or the site is away: ask again later.
        },
      );
    };
    ask();
    const timer = setInterval(ask, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', ask);
    addEventListener('online', ask);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
      removeEventListener('online', ask);
    };
  }, [running, check]);

  if (newer === null || newer === dismissed) return null;
  return (
    <div className="update-notice" role="status">
      <ArrowClockwiseIcon aria-hidden="true" size={20} />
      <span>
        Imp <strong>{newer}</strong> is ready. You are on {running}.
      </span>
      <button
        className="button primary"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          void loadNewestVersion();
        }}
      >
        {loading ? 'Loading…' : 'Update now'}
      </button>
      <button
        className="button quiet icon"
        aria-label="Later"
        title="Later"
        onClick={() => {
          setDismissed(newer);
        }}
      >
        <XIcon aria-hidden="true" />
      </button>
    </div>
  );
}
