import { LibraryAsset, Project } from '@imp/core';
import {
  ArrowSquareOutIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  BooksIcon,
  CaretLeftIcon,
  CopyIcon,
  DotsSixVerticalIcon,
  FileTextIcon,
  FilmReelIcon,
  FilmStripIcon,
  HandGrabbingIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PauseIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  StarIcon,
  TrashIcon,
  UploadSimpleIcon,
  UsersThreeIcon,
  WaveformIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from '../context.js';
import { ConfirmButton } from '../Field.js';
import { useBlobUrl } from '../movie.js';
import { actionsFor } from './actions.js';
import { CrewShelf, useSavedCrewCount } from './crews.js';
import { MixShelf } from './mixes.js';
import { FilmShelf, SHOW_FILMS, takeFilmsRequest, useFilmCount } from '../films.js';
import { useModelMixes } from '../model-bar.js';
import { useDragSource, useLibraryDrag } from './drag.js';
import { formatDuration, Listing, openWhereMade, type Asset } from './model.js';
import { t, tn, tx } from '../../i18n/i18n.js';

const MODALITY_ICONS: Readonly<Record<string, Icon>> = {
  image: ImageIcon,
  sound: WaveformIcon,
  video: FilmStripIcon,
  text: FileTextIcon,
};

const ProjectList = z.object({ projects: z.array(Project) });

/** What the file picker offers: everything the library can take in. */
const ACCEPT =
  'image/*,audio/*,video/*,text/*,.srt,.vtt,.fountain,.md,.txt,.json,.csv,.fdx,.m4a,.opus,.flac';

/** Whether an element has scrolled into view (or near it), so thumbnails load only when seen. */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver !== 'function');
  useEffect(() => {
    const element = ref.current;
    if (element === null || seen) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref, seen]);
  return seen;
}

/** How long a picked sound or video plays, from the browser's own player; null for anything else. */
function measure(file: File): Promise<number | null> {
  const kind = file.type.split('/')[0];
  if (kind !== 'audio' && kind !== 'video') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(kind);
    const done = (seconds: number | null): void => {
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      done(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null);
    };
    element.onerror = () => {
      done(null);
    };
    element.src = url;
  });
}

/** One sound plays at a time in the library; starting another stops the first. */
function usePreview(): {
  playing: string | null;
  toggle: (asset: Asset, url: string | null) => void;
} {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  return {
    playing,
    toggle: (asset, url) => {
      audio.current?.pause();
      if (playing === asset.id || url === null) {
        setPlaying(null);
        return;
      }
      const element = new Audio(url);
      audio.current = element;
      element.onended = () => {
        setPlaying(null);
      };
      void element.play().catch(() => {
        setPlaying(null);
      });
      setPlaying(asset.id);
    },
  };
}

function Thumb({ asset, seen }: { asset: Asset; seen: boolean }): ReactElement {
  const url = useBlobUrl(seen && asset.blobKey !== null ? asset.blobKey : undefined);
  const ModalityIcon = MODALITY_ICONS[asset.modality] ?? BooksIcon;
  if (asset.modality === 'image' && url !== null) {
    return <img src={url} alt="" draggable={false} />;
  }
  if (asset.modality === 'video' && url !== null) {
    return <video src={`${url}#t=0.5`} muted preload="metadata" playsInline aria-hidden="true" />;
  }
  if (asset.modality === 'text' && asset.text !== null) {
    return <p className="library-thumb-text">{asset.text}</p>;
  }
  return (
    <span className="library-thumb-icon">
      <ModalityIcon aria-hidden="true" size={28} weight="light" />
    </span>
  );
}

function Tile({
  asset,
  selected,
  playing,
  onSelect,
  onPlay,
}: {
  asset: Asset;
  selected: boolean;
  playing: boolean;
  onSelect: () => void;
  onPlay: (url: string | null) => void;
}): ReactElement {
  const ref = useRef<HTMLLIElement>(null);
  const seen = useSeen(ref);
  const drag = useDragSource(asset);
  const soundUrl = useBlobUrl(
    asset.modality === 'sound' && asset.blobKey !== null && seen ? asset.blobKey : undefined,
  );
  const duration = formatDuration(asset.durationSeconds);
  return (
    <li
      ref={ref}
      className="library-tile"
      data-modality={asset.modality}
      data-selected={selected}
      {...drag}
    >
      <button
        type="button"
        className="library-tile-main"
        aria-pressed={selected}
        aria-label={`${asset.title}, ${tx(asset.kindLabel)}`}
        onClick={onSelect}
      >
        <span className="library-thumb">
          <Thumb asset={asset} seen={seen} />
          {duration !== '' && <span className="library-duration mono">{duration}</span>}
          {asset.favorite && (
            <StarIcon className="library-star" weight="fill" aria-label={t('Starred')} size={14} />
          )}
        </span>
        <span className="library-tile-text">
          <span className="library-title">{asset.title}</span>
          <span className="library-sub">
            {tx(asset.kindLabel)}
            {asset.context === '' ? '' : ` · ${asset.context}`}
          </span>
        </span>
      </button>
      {asset.modality === 'sound' && asset.blobKey !== null && (
        <button
          type="button"
          className="library-play"
          aria-label={
            playing
              ? t('Stop {title}', { title: asset.title })
              : t('Play {title}', { title: asset.title })
          }
          onClick={() => {
            onPlay(soundUrl);
          }}
        >
          {playing ? (
            <PauseIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
        </button>
      )}
      <span className="library-grip" aria-hidden="true">
        <DotsSixVerticalIcon />
      </span>
    </li>
  );
}

function Preview({
  asset,
  onDuration,
}: {
  asset: Asset;
  onDuration: (seconds: number) => void;
}): ReactElement | null {
  const url = useBlobUrl(asset.blobKey ?? undefined);
  const measured = (event: { currentTarget: HTMLMediaElement }): void => {
    const { duration } = event.currentTarget;
    if (Number.isFinite(duration) && duration > 0) onDuration(duration);
  };
  if (asset.blobKey !== null && url === null) {
    return <div className="library-preview loading" aria-busy="true" />;
  }
  if (asset.modality === 'image' && url !== null) {
    return (
      <div className="library-preview">
        <img src={url} alt={asset.title} />
      </div>
    );
  }
  if (asset.modality === 'video' && url !== null) {
    return (
      <div className="library-preview">
        {/* Generated clips have no captions; their words are in the shot. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={url} controls playsInline onLoadedMetadata={measured} />
      </div>
    );
  }
  if (asset.modality === 'sound' && url !== null) {
    return (
      <div className="library-preview sound">
        <WaveformIcon aria-hidden="true" size={40} weight="light" />
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={url} controls onLoadedMetadata={measured} />
      </div>
    );
  }
  return null;
}

function TagsField({
  tags,
  onCommit,
}: {
  tags: readonly string[];
  onCommit: (tags: string[]) => void;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const next = draft
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '' && !tags.includes(tag));
    setDraft('');
    if (next.length > 0) onCommit([...tags, ...next]);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{t('Tags')}</label>
      <div className="library-tags">
        {tags.map((tag) => (
          <span key={tag} className="tag neutral library-tag">
            {tag}
            <button
              type="button"
              aria-label={t('Remove tag {tag}', { tag })}
              onClick={() => {
                onCommit(tags.filter((candidate) => candidate !== tag));
              }}
            >
              <XIcon aria-hidden="true" size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          className="input"
          value={draft}
          placeholder={tags.length === 0 ? t('Add tags, such as storm or keep') : t('Add a tag')}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
    </div>
  );
}

function Detail({
  project,
  asset,
  onBack,
  onDeleted,
}: {
  project: Project;
  asset: Asset;
  onBack: () => void;
  onDeleted: () => void;
}): ReactElement {
  const imp = useImp();
  const drag = useLibraryDrag();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyTo, setCopyTo] = useState('');
  const [using, setUsing] = useState(false);
  // Read on every render, so a stage that opened meanwhile is offered too.
  const targets = using ? drag.targetsFor(asset) : null;
  const notesId = useId();
  const nameId = useId();
  const textId = useId();
  const own = asset.deletable;
  const full = useLive([`projects/${project.id}/`], async (current) =>
    asset.textTruncated
      ? LibraryAsset.parse(
          await runCommand(current, 'library.get', { projectId: project.id, assetId: asset.id }),
        ).text
      : asset.text,
  );
  const projects = useLive(['project-index/'], async (current) =>
    ProjectList.parse(await runCommand(current, 'project.list', {})).projects.filter(
      (candidate) => candidate.id !== project.id,
    ),
  );
  const text = full.data ?? asset.text;
  const update = (changes: Record<string, unknown>): void => {
    setError(null);
    runCommand(imp, 'library.update', {
      projectId: project.id,
      assetId: asset.id,
      ...changes,
    }).catch((reason: unknown) => {
      setError(messageOf(reason));
    });
  };
  const run = (work: () => Promise<unknown>, done?: string): void => {
    setError(null);
    setNotice(null);
    work().then(
      () => {
        if (done !== undefined) setNotice(done);
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };
  const ModalityIcon = MODALITY_ICONS[asset.modality] ?? BooksIcon;

  return (
    <section className="library-detail" aria-label={t('{title}, details', { title: asset.title })}>
      <div className="library-detail-head">
        <button type="button" className="button quiet small" onClick={onBack}>
          <CaretLeftIcon aria-hidden="true" /> {t('All assets')}
        </button>
        <button
          type="button"
          className="button quiet small library-star-toggle"
          aria-pressed={asset.favorite}
          aria-label={asset.favorite ? t('Remove the star') : t('Star')}
          onClick={() => {
            update({ favorite: !asset.favorite });
          }}
        >
          <StarIcon aria-hidden="true" weight={asset.favorite ? 'fill' : 'regular'} />
        </button>
      </div>
      <Preview
        asset={asset}
        onDuration={(seconds) => {
          if (own && asset.durationSeconds === null) update({ durationSeconds: seconds });
        }}
      />
      <div className="stack tight">
        <span className="eyebrow row">
          <ModalityIcon aria-hidden="true" /> {tx(asset.kindLabel)}
          <span className="muted">· {asset.origin}</span>
        </span>
        {own ? (
          <input
            id={nameId}
            aria-label={t('Name')}
            className="input library-name"
            defaultValue={asset.title}
            key={asset.title}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name !== '' && name !== asset.title) update({ name });
            }}
          />
        ) : (
          <h3 className="library-detail-title">{asset.title}</h3>
        )}
        {asset.context !== '' && <span className="muted small">{asset.context}</span>}
      </div>

      <div className="library-actions">
        {asset.open !== null && (
          <button
            type="button"
            className="button small"
            onClick={() => {
              if (asset.open !== null) openWhereMade(asset.open);
            }}
          >
            <ArrowSquareOutIcon aria-hidden="true" /> {t('Open where it was made')}
          </button>
        )}
        {actionsFor(asset).map((action) => (
          <button
            key={action.id}
            type="button"
            className="button small"
            onClick={() => {
              run(() => action.run(asset, { imp, project }));
            }}
          >
            <action.icon aria-hidden="true" /> {action.label}
          </button>
        ))}
        <button
          type="button"
          className="button small"
          aria-expanded={using}
          onClick={() => {
            setUsing(!using);
          }}
        >
          <HandGrabbingIcon aria-hidden="true" /> {t('Use in…')}
        </button>
      </div>
      {targets !== null && (
        <div className="library-use" role="group" aria-label={t('Use in')}>
          {targets.length === 0 ? (
            <p className="muted small">
              {asset.modality === 'text'
                ? t(
                    'Nothing on this screen takes a text. Open the place you want it, then drag it there or come back here. A text can be dragged into any text field.',
                  )
                : asset.modality === 'image'
                  ? t(
                      'Nothing on this screen takes a picture. Open the place you want it, then drag it there or come back here.',
                    )
                  : asset.modality === 'video'
                    ? t(
                        'Nothing on this screen takes a clip. Open the place you want it, then drag it there or come back here.',
                      )
                    : t(
                        'Nothing on this screen takes a sound. Open the place you want it, such as the audio editor, then drag it there or come back here.',
                      )}
            </p>
          ) : (
            targets.map((target) => (
              <button
                key={target.id}
                type="button"
                className="button small primary"
                onClick={() => {
                  setUsing(false);
                  void drag.place(asset, target.id);
                }}
              >
                {target.label}
              </button>
            ))
          )}
        </div>
      )}

      {asset.modality === 'text' &&
        (own ? (
          <div className="field">
            <label htmlFor={textId}>{t('Text')}</label>
            <textarea
              id={textId}
              className="input script library-text"
              defaultValue={text ?? ''}
              key={text ?? ''}
              rows={10}
              onBlur={(event) => {
                if (event.target.value !== text) update({ text: event.target.value });
              }}
            />
          </div>
        ) : (
          <pre className="library-text read">{text}</pre>
        ))}

      <TagsField
        tags={asset.tags}
        onCommit={(tags) => {
          update({ tags });
        }}
      />
      <div className="field">
        <label htmlFor={notesId}>{t('Notes')}</label>
        <textarea
          id={notesId}
          className="input"
          rows={2}
          defaultValue={asset.notes}
          key={asset.notes}
          placeholder={t('Why it matters, where it goes')}
          onBlur={(event) => {
            if (event.target.value !== asset.notes) update({ notes: event.target.value });
          }}
        />
      </div>

      {(projects.data?.length ?? 0) > 0 && (asset.blobKey !== null || asset.text !== null) && (
        <div className="row library-copy">
          <label className="sr-only" htmlFor={`${notesId}-copy`}>
            {t('Copy to project')}
          </label>
          <select
            id={`${notesId}-copy`}
            className="select"
            value={copyTo}
            onChange={(event) => {
              setCopyTo(event.target.value);
            }}
          >
            <option value="">{t('Copy to another project…')}</option>
            {projects.data?.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button small"
            disabled={copyTo === ''}
            onClick={() => {
              const name = projects.data?.find((p) => p.id === copyTo)?.name ?? t('the project');
              run(
                () =>
                  runCommand(imp, 'library.copy', {
                    projectId: project.id,
                    assetIds: [asset.id],
                    toProjectId: copyTo,
                  }),
                t('Copied to “{name}”.', { name }),
              );
            }}
          >
            <CopyIcon aria-hidden="true" /> {t('Copy')}
          </button>
        </div>
      )}
      {own && (
        <ConfirmButton
          label={t('Delete from the library')}
          question={t('Delete “{title}” from the library? Where it was placed, it stops playing.', {
            title: asset.title,
          })}
          onConfirm={() => {
            run(async () => {
              await runCommand(imp, 'library.delete', {
                projectId: project.id,
                assetId: asset.id,
              });
              onDeleted();
            });
          }}
        >
          <TrashIcon aria-hidden="true" />
        </ConfirmButton>
      )}
      {notice !== null && <p className="ok small">{notice}</p>}
      {(error ?? drag.problem) !== null && (
        <p className="error small" role="alert">
          {error ?? drag.problem}
        </p>
      )}
    </section>
  );
}

/**
 * The library of the open project: everything it made, wrote or brought in,
 * in one place, beside whatever stage is open. Search it, filter it, drag an
 * asset to where it is used (hold it a moment on a tablet), or tap it for
 * everything it can do.
 */
export function LibraryPanel({
  project,
  wide,
  onToggleWide,
  onClose,
}: {
  project: Project;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
}): ReactElement {
  const imp = useImp();
  const drag = useLibraryDrag();
  const searchId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [modality, setModality] = useState<string | null>(null);
  // The Crews and Mixes tabs show saved crews or model mixes in place of assets.
  // A request for the Films shelf (from a notice or a chat card) may have opened the library.
  const [opening] = useState(takeFilmsRequest);
  const [shelf, setShelf] = useState<'crews' | 'mixes' | 'films' | null>(
    opening === null ? null : 'films',
  );
  const [playingFilm, setPlayingFilm] = useState<string | null>(opening?.filmId ?? null);
  const crews = shelf !== null;
  const movie = project.mode === 'movie';
  const filmCount = useFilmCount(movie ? project.id : null);
  const crewCount = useSavedCrewCount();
  const mixCount = useModelMixes().data?.mixes.length;
  const [kind, setKind] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name'>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const preview = usePreview();

  useEffect(() => {
    const onShow = (): void => {
      const request = takeFilmsRequest();
      if (request === null) return;
      setShelf('films');
      setSelectedId(null);
      setPlayingFilm(request.filmId);
    };
    window.addEventListener(SHOW_FILMS, onShow);
    return () => {
      window.removeEventListener(SHOW_FILMS, onShow);
    };
  }, []);

  // A finished import says so for a moment; errors stay until dismissed.
  useEffect(() => {
    if (status === null || status.endsWith('…')) return undefined;
    const timer = window.setTimeout(() => {
      setStatus(null);
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(query);
    }, 150);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const filters = { query: debounced, modality, kind, tag, favorite, sort };
  const listing = useLive([`projects/${project.id}/`, JSON.stringify(filters)], async (current) =>
    Listing.parse(
      await runCommand(current, 'library.list', {
        projectId: project.id,
        query: debounced,
        ...(modality === null ? {} : { modality }),
        ...(kind === null ? {} : { kind }),
        ...(tag === null ? {} : { tag }),
        ...(favorite ? { favorite: true } : {}),
        sort,
        limit: 500,
      }),
    ),
  );
  const data = listing.data;
  const assets = data?.assets ?? [];
  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const allCount = data?.facets.modalities.reduce((sum, facet) => sum + facet.count, 0) ?? 0;
  const kinds = modality === null ? [] : (data?.facets.kinds ?? []);

  const importFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    setError(null);
    void (async () => {
      let done = 0;
      for (const file of files) {
        setStatus(
          files.length === 1
            ? t('Importing {name}…', { name: file.name })
            : t('Importing {value} of {count}…', {
                value: String(done + 1),
                count: String(files.length),
              }),
        );
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const fileKey = await imp.upload(bytes, file.type);
          const asset = LibraryAsset.parse(
            await runCommand(imp, 'library.import', {
              projectId: project.id,
              fileKey,
              fileName: file.name,
            }),
          );
          done += 1;
          if (files.length === 1) setSelectedId(asset.id);
          void measure(file).then((seconds) => {
            if (seconds === null) return;
            void runCommand(imp, 'library.update', {
              projectId: project.id,
              assetId: asset.id,
              durationSeconds: seconds,
            }).catch(() => undefined);
          });
        } catch (reason) {
          setError(`${file.name}: ${messageOf(reason)}`);
        }
      }
      setStatus(done === 0 ? null : tn(done, 'Imported {count} file.', 'Imported {count} files.'));
    })();
  };

  const onFileDrag = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setFileOver(event.type !== 'dragleave');
  };

  return (
    <aside
      className="library-panel"
      aria-label={t('Library')}
      data-wide={wide}
      data-file-over={fileOver}
      onDragOver={onFileDrag}
      onDragEnter={onFileDrag}
      onDragLeave={onFileDrag}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setFileOver(false);
        importFiles([...event.dataTransfer.files]);
      }}
    >
      <div className="library-head">
        <div className="stack tight">
          <span className="eyebrow">{project.name}</span>
          <h2>{t('Library')}</h2>
        </div>
        <div className="row library-head-buttons">
          <button
            type="button"
            className="button quiet small library-import"
            aria-label={t('Import files')}
            title={t('Import pictures, sounds, clips or texts')}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            <UploadSimpleIcon aria-hidden="true" /> <span className="label">{t('Import')}</span>
          </button>
          <button
            type="button"
            className="button quiet small"
            aria-label={t('Write a note')}
            title={t('Write a note')}
            onClick={() => {
              runCommand(imp, 'library.text.create', {
                projectId: project.id,
                name: t('New note'),
                text: '',
              }).then(
                (output) => {
                  setSelectedId(LibraryAsset.parse(output).id);
                },
                (reason: unknown) => {
                  setError(messageOf(reason));
                },
              );
            }}
          >
            <NotePencilIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button quiet small library-wide-toggle"
            aria-pressed={wide}
            aria-label={wide ? t('Narrow the library') : t('Widen the library')}
            title={wide ? t('Narrow') : t('Widen')}
            onClick={onToggleWide}
          >
            {wide ? (
              <ArrowsInSimpleIcon aria-hidden="true" />
            ) : (
              <ArrowsOutSimpleIcon aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="button quiet small"
            aria-label={t('Close the library')}
            title={t('Close')}
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          aria-label={t('Files to import')}
          onChange={(event) => {
            importFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>

      {selected !== null ? (
        <Detail
          key={selected.id}
          project={project}
          asset={selected}
          onBack={() => {
            setSelectedId(null);
          }}
          onDeleted={() => {
            setSelectedId(null);
          }}
        />
      ) : (
        <>
          <div className="library-search">
            <MagnifyingGlassIcon aria-hidden="true" />
            <label className="sr-only" htmlFor={searchId}>
              {t('Search the library')}
            </label>
            <input
              id={searchId}
              type="search"
              className="input"
              placeholder={
                shelf === 'films'
                  ? t('Search films')
                  : shelf === 'crews'
                    ? t('Search saved crews')
                    : shelf === 'mixes'
                      ? t('Search model mixes')
                      : t('Search names, words, tags')
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <div className="library-modalities" role="tablist" aria-label={t('What to show')}>
            <button
              type="button"
              role="tab"
              aria-selected={modality === null && !crews}
              className="library-modality"
              onClick={() => {
                setModality(null);
                setKind(null);
                setShelf(null);
              }}
            >
              <span>{t('All')}</span>
              <span className="count">{allCount}</span>
            </button>
            {data?.facets.modalities.map((facet) => {
              const FacetIcon = MODALITY_ICONS[facet.id] ?? BooksIcon;
              return (
                <button
                  key={facet.id}
                  type="button"
                  role="tab"
                  aria-selected={modality === facet.id && !crews}
                  aria-label={`${tx(facet.label)}, ${String(facet.count)}`}
                  title={tx(facet.label)}
                  className="library-modality"
                  onClick={() => {
                    setModality(facet.id);
                    setKind(null);
                    setShelf(null);
                  }}
                >
                  <FacetIcon aria-hidden="true" />
                  <span className="label">{tx(facet.label)}</span>
                  <span className="count">{facet.count}</span>
                </button>
              );
            })}
            {movie && (
              <button
                type="button"
                role="tab"
                aria-selected={shelf === 'films'}
                aria-label={t('Films, {value}', { value: String(filmCount ?? 0) })}
                title={t('Rendered films')}
                className="library-modality"
                onClick={() => {
                  setShelf('films');
                  setPlayingFilm(null);
                }}
              >
                <FilmReelIcon aria-hidden="true" />
                <span className="label">{t('Films')}</span>
                <span className="count">{filmCount ?? 0}</span>
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={shelf === 'crews'}
              aria-label={t('Crews, {value}', { value: String(crewCount ?? 0) })}
              title={t('Saved crews')}
              className="library-modality"
              onClick={() => {
                setShelf('crews');
              }}
            >
              <UsersThreeIcon aria-hidden="true" />
              <span className="label">{t('Crews')}</span>
              <span className="count">{crewCount ?? 0}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={shelf === 'mixes'}
              aria-label={t('Model mixes, {value}', { value: String(mixCount ?? 0) })}
              title={t('Model mixes')}
              className="library-modality"
              onClick={() => {
                setShelf('mixes');
              }}
            >
              <SlidersHorizontalIcon aria-hidden="true" />
              <span className="label">{t('Mixes')}</span>
              <span className="count">{mixCount ?? 0}</span>
            </button>
          </div>
          {shelf === 'films' ? (
            <FilmShelf projectId={project.id} query={debounced} playing={playingFilm} />
          ) : shelf === 'mixes' ? (
            <MixShelf
              query={debounced}
              onStatus={(message, failed = false) => {
                if (failed) setError(message);
                else setStatus(message);
              }}
            />
          ) : shelf === 'crews' ? (
            <CrewShelf
              query={debounced}
              onStatus={(message, failed = false) => {
                if (failed) setError(message);
                else setStatus(message);
              }}
            />
          ) : (
            <>
              <div className="library-filters">
                {kinds.length > 1 &&
                  kinds.map((facet) => (
                    <button
                      key={facet.id}
                      type="button"
                      className="chip small"
                      aria-pressed={kind === facet.id}
                      onClick={() => {
                        setKind(kind === facet.id ? null : facet.id);
                      }}
                    >
                      <span>{tx(facet.label)}</span> <span className="muted">{facet.count}</span>
                    </button>
                  ))}
                {(data?.facets.tags.length ?? 0) > 0 && (
                  <select
                    className="select small"
                    aria-label={t('Tag')}
                    value={tag ?? ''}
                    onChange={(event) => {
                      setTag(event.target.value === '' ? null : event.target.value);
                    }}
                  >
                    <option value="">{t('Any tag')}</option>
                    {data?.facets.tags.map((facet) => (
                      <option key={facet.id} value={facet.id}>
                        {facet.label} ({facet.count})
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="chip small"
                  aria-pressed={favorite}
                  onClick={() => {
                    setFavorite(!favorite);
                  }}
                >
                  <StarIcon aria-hidden="true" weight={favorite ? 'fill' : 'regular'} />
                  <span>{t('Starred')}</span>
                </button>
                <select
                  className="select small library-sort"
                  aria-label={t('Order')}
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as typeof sort);
                  }}
                >
                  <option value="newest">{t('Newest first')}</option>
                  <option value="oldest">{t('Oldest first')}</option>
                  <option value="name">{t('By name')}</option>
                </select>
              </div>
              {listing.error !== null && <p className="error small">{listing.error}</p>}
              {data !== undefined && assets.length === 0 && (
                <div className="library-empty">
                  <BooksIcon aria-hidden="true" size={36} weight="light" />
                  <p>
                    {allCount === 0 && debounced === '' && modality === null && !favorite
                      ? t(
                          'Nothing here yet. Everything this project makes appears here by itself: portraits, key frames, clips, dialogue, effects, music and scenes. Import your own files with Import, or drop them here.',
                        )
                      : t('Nothing matches. Try other words or clear a filter.')}
                  </p>
                </div>
              )}
              <ul className="library-grid" aria-label={t('Assets')}>
                {assets.map((asset) => (
                  <Tile
                    key={asset.id}
                    asset={asset}
                    selected={false}
                    playing={preview.playing === asset.id}
                    onSelect={() => {
                      setSelectedId(asset.id);
                    }}
                    onPlay={(url) => {
                      preview.toggle(asset, url);
                    }}
                  />
                ))}
              </ul>
              {assets.length > 0 && (
                <p className="muted small library-hint">
                  {t(
                    'Drag an asset to where it is used, holding it a moment on a tablet, or tap it for more.',
                  )}
                </p>
              )}
            </>
          )}
        </>
      )}
      {(status !== null || error !== null || (selected === null && drag.problem !== null)) && (
        <div className="library-status" role="status">
          {error ?? (selected === null ? drag.problem : null) ?? status}
          <button
            type="button"
            className="button quiet small"
            aria-label={t('Dismiss')}
            onClick={() => {
              setStatus(null);
              setError(null);
              drag.clearProblem();
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
        </div>
      )}
      {fileOver && (
        <div className="library-drop-files" aria-hidden="true">
          <UploadSimpleIcon size={32} weight="light" />
          <span>{t('Drop to import')}</span>
        </div>
      )}
    </aside>
  );
}
