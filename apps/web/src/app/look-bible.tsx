import type { Project } from '@imp/core';
import { FilmStyle, IMAGE_MODEL_SETTING } from '@imp/mode-movie';
import { SparkleIcon, TrashIcon } from '@phosphor-icons/react';
import { useId, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { runCommand, useLive } from './context.js';
import { ConfirmButton, EditableField } from './Field.js';
import { useLibraryDrop } from './library/drag.js';
import { Problem, useAct, useBlobUrl, useModelSetting } from './movie.js';
import { Price } from './spend.js';
import { t } from '../i18n/i18n.js';

const FIELDS: readonly {
  key: 'palette' | 'light' | 'camera' | 'era';
  label: () => string;
  placeholder: () => string;
}[] = [
  {
    key: 'palette',
    label: () => t('Palette'),
    placeholder: () => t('Cold blues and sodium orange, no green.'),
  },
  {
    key: 'light',
    label: () => t('Light'),
    placeholder: () => t('Low key, hard side light, deep shadows.'),
  },
  {
    key: 'camera',
    label: () => t('Camera and picture'),
    placeholder: () => t('35mm film grain, anamorphic, shallow focus, handheld.'),
  },
  {
    key: 'era',
    label: () => t('Era and place'),
    placeholder: () => t('1970s Scottish coast, worn and practical.'),
  },
];

function LookImage({ blobKey, alt }: { blobKey: string; alt: string }): ReactElement | null {
  const url = useBlobUrl(blobKey);
  return url === null ? null : <img src={url} alt={alt} />;
}

/**
 * The look bible of a film: its palette, light, camera and era in words, and
 * the look pictures, of which the chosen one goes with every picture made for
 * the film. It is what keeps a long film looking like one film.
 */
export function LookBible({ project }: { project: Project }): ReactElement {
  const live = useLive([`projects/${project.id}/movie/style`], async (imp) =>
    FilmStyle.parse(await runCommand(imp, 'movie.style.get', { projectId: project.id })),
  );
  const { act, error, retry } = useAct(project);
  const images = useModelSetting(IMAGE_MODEL_SETTING, 'image');
  const directionId = useId();
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const style = live.data;
  const chosen = style?.images.find((image) => image.id === style.keyImageId);

  const paint = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    void act('movie.style.image.generate', {
      ...(direction.trim() === '' ? {} : { direction: direction.trim() }),
    }).finally(() => {
      setBusy(false);
    });
  };

  // A picture from the library can set the look too, such as a still or a painting.
  const drop = useRef<HTMLDivElement>(null);
  useLibraryDrop(drop, {
    label: t('Look of the film'),
    accepts: (asset) => asset.modality === 'image' && asset.blobKey !== null,
    onDrop: async (asset) => {
      await act('movie.style.image.fromFile', { blobKey: asset.blobKey });
    },
  });

  return (
    <section className="card stack page look-bible" aria-label={t('Visual style')}>
      <div className="stack">
        <h2>{t('Visual style')}</h2>
        <span className="muted">
          {t(
            'How the film looks. Every portrait, place and key frame is drawn in it, with the chosen look picture beside it, so a long film keeps one look. The Production Designer can write it for you.',
          )}
        </span>
      </div>
      <Problem text={live.error ?? error ?? images.error} retry={retry} />
      {style !== undefined && (
        <div className="look-bible-grid">
          <div className="stack">
            {FIELDS.map((field) => (
              <EditableField
                key={field.key}
                label={field.label()}
                value={style[field.key]}
                placeholder={field.placeholder()}
                rows={2}
                onCommit={(value) => act('movie.style.update', { [field.key]: value })}
              />
            ))}
          </div>
          <div className="stack look-pictures" ref={drop}>
            <div className="look-key" aria-busy={busy}>
              {chosen === undefined ? (
                <span className="muted look-empty">
                  {t('No look picture yet. Paint one, or drop a picture from the library here.')}
                </span>
              ) : (
                <LookImage blobKey={chosen.blobKey} alt={t('The chosen look picture')} />
              )}
              {busy && (
                <span className="portrait-busy" role="status">
                  {t('Developing…')}
                </span>
              )}
            </div>
            {style.images.length > 1 && (
              <div className="thumbs" role="group" aria-label={t('Look pictures')}>
                {style.images.map((image, index) => (
                  <button
                    key={image.id}
                    type="button"
                    className="thumb"
                    aria-pressed={image.id === style.keyImageId}
                    aria-label={t('Use look picture {value}', { value: String(index + 1) })}
                    title={image.prompt}
                    onClick={() => {
                      void act('movie.style.image.select', { imageId: image.id });
                    }}
                  >
                    <LookImage blobKey={image.blobKey} alt="" />
                  </button>
                ))}
              </div>
            )}
            <form className="row portrait-make" onSubmit={paint}>
              <label className="sr-only" htmlFor={directionId}>
                {t('Direction for the next look picture')}
              </label>
              <input
                id={directionId}
                type="text"
                className="input"
                value={direction}
                placeholder={t('Direction, e.g. a night exterior')}
                onChange={(event) => {
                  setDirection(event.target.value);
                }}
              />
              <button
                type="submit"
                className="button"
                disabled={busy || images.model === null}
                title={
                  images.model === null
                    ? t('Choose an image model first.')
                    : t('Made with {model}', { model: images.model })
                }
              >
                <SparkleIcon aria-hidden="true" />{' '}
                {chosen === undefined ? t('Paint the look') : t('Another')}
                <Price command="movie.style.image.generate" input={{ projectId: project.id }} />
              </button>
            </form>
            {chosen !== undefined && (
              <div className="row">
                <ConfirmButton
                  label={t('Delete look picture')}
                  question={t('Delete this look picture for good?')}
                  onConfirm={() => {
                    void act('movie.style.image.delete', { imageId: chosen.id });
                  }}
                >
                  <TrashIcon aria-hidden="true" />
                </ConfirmButton>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
