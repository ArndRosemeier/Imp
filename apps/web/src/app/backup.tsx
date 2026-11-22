import {
  BACKUP_PREFIX,
  BackupPending,
  BackupProgress,
  BackupRestored,
  BackupSaved,
} from '@imp/core';
import type { ImpClient } from '@imp/host';
import {
  ArchiveIcon,
  DownloadSimpleIcon,
  LockKeyIcon,
  UploadSimpleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { z } from 'zod';
import { LEGACY_KEY_NAME } from '../host/secrets.js';
import { messageOf, runCommand, useImp, useLive, type Live } from './context.js';
import { Problem } from './movie.js';
import { ago, Modal } from './projects.js';
import { canPickWhereToSave, saveFileAs } from './save-file.js';

/**
 * Save all and Load all: everything in Imp as one .zip file, and back. The
 * core does the packing and unpacking (backup.save, backup.load), so agents
 * can do both; the page asks where to save, streams the file there, and
 * carries its own preferences (theme, panel widths) along.
 */

const Status = z.object({
  lastSaved: BackupSaved.nullable(),
  pending: BackupPending.nullable(),
  progress: BackupProgress.nullable(),
  lastLoaded: BackupRestored.nullable(),
});
type Status = z.infer<typeof Status>;

/** Set across the reload that follows a load, to say what came back. */
const LOADED_NOTE = 'imp.backup.loaded';

export function useBackupStatus(): Live<Status> {
  return useLive([BACKUP_PREFIX], async (imp) =>
    Status.parse(await runCommand(imp, 'backup.status', {})),
  );
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/** Page preferences worth carrying: Imp's own, never anything that looks like a credential. */
function carried(key: string): boolean {
  return key.startsWith('imp.') && key !== LEGACY_KEY_NAME && !/key|secret|token/i.test(key);
}

function pagePreferences(): Record<string, string> {
  const prefs: Record<string, string> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !carried(key) || key === LOADED_NOTE) continue;
      const value = localStorage.getItem(key);
      if (value !== null) prefs[key] = value;
    }
  } catch {
    // Storage blocked: the backup simply carries no page preferences.
  }
  return prefs;
}

function applyPagePreferences(prefs: Record<string, string> | undefined): void {
  if (prefs === undefined) return;
  try {
    for (const [key, value] of Object.entries(prefs)) {
      if (carried(key)) localStorage.setItem(key, value);
    }
  } catch {
    // Storage blocked: everything else is loaded all the same.
  }
}

/** Reloads the page on what was loaded, and leaves a note to say so. */
function reloadAfterLoad(restored: { savedAt: string; projects: number }): void {
  try {
    sessionStorage.setItem(LOADED_NOTE, JSON.stringify(restored));
  } catch {
    // No note then; the reload still shows the loaded work.
  }
  window.location.reload();
}

async function* backupParts(imp: ImpClient, parts: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const key of parts) {
    const part = await imp.blob(key, true);
    if (part === undefined) throw new Error('Part of the backup is missing. Save all again.');
    yield part.bytes;
  }
}

function backupName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `imp-backup-${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/**
 * Whether this page is saving or loading right now, across components: a
 * backup it packs itself is written at once and must not also be offered as
 * one waiting to be kept.
 */
let ownWork = 0;
const ownWorkListeners = new Set<() => void>();
function setOwnWork(change: 1 | -1): void {
  ownWork += change;
  for (const listener of ownWorkListeners) listener();
}
function usePageWorking(): boolean {
  return useSyncExternalStore(
    (listener) => {
      ownWorkListeners.add(listener);
      return () => ownWorkListeners.delete(listener);
    },
    () => ownWork > 0,
  );
}

interface Work {
  readonly label: string;
  readonly done?: number;
  readonly total?: number;
}

/**
 * The actions behind the buttons, shared by the Settings card, the Projects
 * dialog and the notice for a backup an agent made.
 */
function useBackupActions() {
  const imp = useImp();
  const [work, setWork] = useState<Work | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /** Saves a backup that is already packed (by an agent, or just now) to a place the person picks. */
  const keep = async (pending: BackupPending | null): Promise<boolean> => {
    const outcome = await saveFileAs(
      {
        suggestedName: pending?.fileName ?? backupName(),
        mediaType: 'application/zip',
        description: 'Imp backup',
      },
      async () => {
        let ready = pending;
        if (ready === null) {
          setWork({ label: 'Packing everything' });
          ready = BackupPending.parse(
            await runCommand(imp, 'backup.save', { interface: pagePreferences() }),
          );
        }
        setWork({ label: `Writing ${sizeLabel(ready.sizeBytes)}` });
        return backupParts(imp, ready.parts);
      },
    );
    // The parts were taken as they were written; this forgets the waiting record.
    await runCommand(imp, 'backup.discard', {});
    if (outcome.saved) {
      setDone(
        outcome.where === 'picked'
          ? `Saved everything to ${outcome.name}.`
          : `Saved everything to ${outcome.name} in your downloads.`,
      );
    }
    return outcome.saved;
  };

  const run = (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    setDone(null);
    setOwnWork(1);
    return action()
      .then(() => true)
      .catch((reason: unknown) => {
        setError(messageOf(reason));
        return false;
      })
      .finally(() => {
        setOwnWork(-1);
        setWork(null);
      });
  };

  return {
    work,
    error,
    done,
    saveAll: () => run(() => keep(null)),
    keepPending: (pending: BackupPending) => run(() => keep(pending)),
    discardPending: () => run(() => runCommand(imp, 'backup.discard', {})),
    loadAll: (file: File) =>
      run(async () => {
        setWork({ label: 'Reading the file', done: 0, total: file.size });
        const fileKey = await imp.uploadFile(file, (sent) => {
          setWork({ label: 'Reading the file', done: sent, total: file.size });
        });
        setWork({ label: 'Checking the file' });
        const loaded = z
          .object({
            savedAt: z.string(),
            projects: z.number(),
            interface: z.record(z.string(), z.string()).optional(),
          })
          .parse(await runCommand(imp, 'backup.load', { fileKey }));
        applyPagePreferences(loaded.interface);
        reloadAfterLoad(loaded);
      }),
  };
}

function WorkLine({ work, progress }: { work: Work | null; progress: BackupProgress | null }) {
  // The core's progress is the more exact one while it packs or restores.
  const label = progress?.phase ?? work?.label;
  if (label === undefined) return null;
  const done = progress?.doneBytes ?? work?.done;
  const total = progress?.totalBytes ?? work?.total;
  const measured = done !== undefined && total !== undefined && total > 0;
  const counting = progress?.phase === 'Packing files';
  return (
    <div className="backup-work" role="status">
      {measured ? (
        <progress aria-label={label} max={total} value={done} />
      ) : (
        <progress aria-label={label} />
      )}
      <span className="muted small">
        {label}
        {measured &&
          (counting
            ? ` · ${String(done)} of ${String(total)} files`
            : ` · ${sizeLabel(done)} of ${sizeLabel(total)}`)}
        …
      </span>
    </div>
  );
}

const CONTENTS = [
  'Projects, media and films',
  'Library',
  'Saved crews',
  'Model mixes',
  'Roles',
  'Conversations',
  'Settings and help choices',
];

/** Save all and Load all, with what they cover and how the last one went. */
export function BackupPanel(): ReactElement {
  const status = useBackupStatus();
  const actions = useBackupActions();
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const data = status.data;
  const busy = actions.work !== null || (data?.progress ?? null) !== null;
  const lastSaved = data?.lastSaved ?? null;
  return (
    <div className="backup stack">
      <div className="backup-head">
        <span className="backup-badge" aria-hidden="true">
          <ArchiveIcon size={22} weight="duotone" />
        </span>
        <p className="muted">
          One .zip file with everything in Imp, to keep as a backup or to move your work between
          browsers, computers and the local server.
        </p>
      </div>
      <ul className="backup-contents" aria-label="What a backup holds">
        {CONTENTS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="backup-key">
        <LockKeyIcon aria-hidden="true" weight="fill" /> Your OpenRouter key is never in the file.
      </p>
      <div className="row wrap backup-actions">
        <button
          className="button primary"
          disabled={busy}
          onClick={() => {
            void actions.saveAll();
          }}
        >
          <DownloadSimpleIcon aria-hidden="true" /> Save all
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            picker.current?.click();
          }}
        >
          <UploadSimpleIcon aria-hidden="true" /> Load all…
        </button>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-label="Backup file to load"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) setChosen(file);
          }}
        />
        <span className="muted small">
          {lastSaved === null
            ? 'Not saved yet.'
            : `Last saved ${ago(lastSaved.savedAt)} · ${sizeLabel(lastSaved.sizeBytes)}`}
        </span>
      </div>
      <WorkLine work={actions.work} progress={data?.progress ?? null} />
      {actions.done !== null && (
        <p className="notice" role="status">
          {actions.done}
        </p>
      )}
      <Problem text={actions.error ?? status.error} />
      {!canPickWhereToSave() && (
        <p className="muted small">
          This browser saves files to its downloads; Chrome and Edge on a computer ask where.
        </p>
      )}
      <ConfirmLoad
        file={chosen}
        onClose={() => {
          setChosen(null);
        }}
        onSaveFirst={actions.saveAll}
        onLoad={(file) => {
          setChosen(null);
          void actions.loadAll(file);
        }}
      />
    </div>
  );
}

function ConfirmLoad({
  file,
  onClose,
  onSaveFirst,
  onLoad,
}: {
  file: File | null;
  onClose: () => void;
  onSaveFirst: () => Promise<boolean>;
  onLoad: (file: File) => void;
}): ReactElement {
  const [savingFirst, setSavingFirst] = useState(false);
  // Which file the current work was saved for, so a new pick asks again.
  const [savedFor, setSavedFor] = useState<File | null>(null);
  const savedFirst = savedFor !== null && savedFor === file;
  return (
    <Modal open={file !== null} onClose={onClose} label="Load all">
      <div className="modal-body stack">
        <div className="eyebrow">Load all</div>
        <h2>Replace everything with this backup?</h2>
        <p className="backup-file mono">
          {file?.name} · {sizeLabel(file?.size ?? 0)}
        </p>
        <p className="muted">
          Imp will hold exactly what the file holds. Projects, library items, crews and settings
          that are here now and not in the file will be gone. Your OpenRouter key stays as it is.
          The file is checked in full first: if it is damaged, nothing changes.
        </p>
        <div className="backup-warning">
          <WarningIcon aria-hidden="true" weight="fill" />
          <span>
            {savedFirst
              ? 'Your current work is saved. You can load the backup now.'
              : 'Save all first if you may want your current work back.'}
          </span>
        </div>
        <div className="row spread wrap">
          <button className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <div className="row wrap">
            <button
              className="button"
              disabled={savingFirst}
              onClick={() => {
                setSavingFirst(true);
                void onSaveFirst()
                  .then((saved) => {
                    if (saved) setSavedFor(file);
                  })
                  .finally(() => {
                    setSavingFirst(false);
                  });
              }}
            >
              <DownloadSimpleIcon aria-hidden="true" /> {savingFirst ? 'Saving…' : 'Save all first'}
            </button>
            <button
              className="button danger"
              disabled={savingFirst}
              onClick={() => {
                if (file !== null) onLoad(file);
              }}
            >
              <UploadSimpleIcon aria-hidden="true" /> Replace everything
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The Projects screen's way in: a button that opens the panel in a dialog. */
export function BackupButton(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="button"
        title="Save everything to one file, or load it back"
        onClick={() => {
          setOpen(true);
        }}
      >
        <ArchiveIcon aria-hidden="true" /> Save all / Load all
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        label="Save all and Load all"
      >
        <div className="modal-body stack">
          <div className="row spread">
            <div className="eyebrow">Backup</div>
            <button
              className="icon-button"
              aria-label="Close"
              onClick={() => {
                setOpen(false);
              }}
            >
              <XIcon aria-hidden="true" />
            </button>
          </div>
          <h2>Save all and Load all</h2>
          <BackupPanel />
        </div>
      </Modal>
    </>
  );
}

/**
 * Always on screen: offers to keep a backup an agent packed, reloads the page
 * when a backup was loaded elsewhere (by an agent, or in another window), and
 * says what came back after a load.
 */
export function BackupWatcher(): ReactElement | null {
  const status = useBackupStatus();
  const actions = useBackupActions();
  const seenRestore = useRef<string | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(() => {
    try {
      const raw = sessionStorage.getItem(LOADED_NOTE);
      if (raw === null) return null;
      sessionStorage.removeItem(LOADED_NOTE);
      const loaded = z.object({ savedAt: z.string(), projects: z.number() }).parse(JSON.parse(raw));
      return `Loaded everything from the backup saved ${ago(loaded.savedAt)}: ${String(loaded.projects)} ${loaded.projects === 1 ? 'project' : 'projects'}.`;
    } catch {
      return null;
    }
  });

  const restored = status.data?.lastLoaded ?? null;
  useEffect(() => {
    if (status.data === undefined) return;
    const at = restored?.restoredAt ?? null;
    if (seenRestore.current === undefined) {
      seenRestore.current = at;
      return;
    }
    if (at !== null && at !== seenRestore.current && restored !== null) {
      seenRestore.current = at;
      applyPagePreferences(restored.interface);
      reloadAfterLoad(restored);
    }
  }, [status.data, restored]);

  useEffect(() => {
    if (note === null) return undefined;
    const timer = setTimeout(() => {
      setNote(null);
    }, 12_000);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  const pageWorking = usePageWorking();
  const pending = status.data?.pending ?? null;
  const working = pageWorking || (status.data?.progress ?? null) !== null;
  // A backup the page packs itself is saved at once; only one an agent packed waits here.
  const offer = pending !== null && !working;
  if (!offer && note === null && actions.error === null) return null;
  return (
    <div className="backup-toast" role="status">
      {offer ? (
        <>
          <ArchiveIcon aria-hidden="true" size={20} weight="duotone" />
          <span>
            Everything is packed into one file ({sizeLabel(pending.sizeBytes)}), ready to keep.
          </span>
          <button
            className="button primary small"
            onClick={() => {
              void actions.keepPending(pending);
            }}
          >
            <DownloadSimpleIcon aria-hidden="true" /> Save…
          </button>
          <button
            className="button quiet small"
            onClick={() => {
              void actions.discardPending();
            }}
          >
            Discard
          </button>
        </>
      ) : (
        <>
          <span>{actions.error ?? note}</span>
          <button
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => {
              setNote(null);
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
