import { t } from '../i18n/i18n.js';
/**
 * Saving a file to the person's computer. Where the browser lets a page ask
 * where to save (Chrome, Edge and other Chromium browsers on computers), the
 * system's save dialog opens, so the person picks the folder and the name;
 * elsewhere (Safari, Firefox, iPad) the file goes to the browser's downloads,
 * which is all those browsers allow.
 *
 * The dialog opens first, while the click that asked for it still counts as
 * the person's own action (browsers allow the dialog only then), and the file
 * is made after: a cancelled dialog makes nothing.
 */

/** What can be saved: bytes, a Blob, or pieces in order, written as they come. */
export type SaveContent = Uint8Array | Blob | AsyncIterable<Uint8Array>;

export interface SaveRequest {
  /** The name offered in the dialog and given to a download. */
  readonly suggestedName: string;
  /** The file's media type, such as application/zip. */
  readonly mediaType: string;
  /** What the dialog calls this kind of file, such as "Imp backup". */
  readonly description?: string;
}

/** How a save ended: saved (where the person chose, or to downloads), or cancelled in the dialog. */
export type SaveOutcome =
  | { readonly saved: true; readonly name: string; readonly where: 'picked' | 'downloads' }
  | { readonly saved: false };

interface WritableFile {
  write(data: Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface PickedFile {
  readonly name: string;
  createWritable(): Promise<WritableFile>;
  /** Chromium only: removes the file, which the dialog made empty, when making it failed. */
  remove?: () => Promise<void>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  id?: string;
  startIn?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<PickedFile>;

function picker(): ShowSaveFilePicker | null {
  const candidate = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  // Not offered in frames from another site, where it would only throw.
  if (typeof candidate !== 'function' || window.self !== window.top) return null;
  return (candidate as ShowSaveFilePicker).bind(window);
}

/** Whether this browser opens a save dialog, rather than saving to downloads. */
export function canPickWhereToSave(): boolean {
  return picker() !== null;
}

/** The extension the dialog filters on: ".zip" for "film.imp.zip". */
function extensionOf(name: string): string | null {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  return match === null ? null : match[0].toLowerCase();
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Bytes, from this page or handed over from a worker (another realm, where instanceof fails). */
function isBytes(content: SaveContent): content is Uint8Array {
  return ArrayBuffer.isView(content);
}

async function toBlob(content: SaveContent, mediaType: string): Promise<Blob> {
  if (content instanceof Blob) return content;
  if (isBytes(content)) return new Blob([content.slice()], { type: mediaType });
  const parts: BlobPart[] = [];
  for await (const piece of content) parts.push(piece.slice());
  return new Blob(parts, { type: mediaType });
}

/** Hands a file to the browser's downloads. */
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/**
 * Asks where to save, then makes the file with `make` and writes it there.
 * Call it straight from a click or key press. Fails with `make`'s error, and
 * leaves no half-written file behind.
 */
export async function saveFileAs(
  request: SaveRequest,
  make: () => Promise<SaveContent> | SaveContent,
): Promise<SaveOutcome> {
  const show = picker();
  let handle: PickedFile | null = null;
  if (show !== null) {
    const extension = extensionOf(request.suggestedName);
    try {
      handle = await show({
        suggestedName: request.suggestedName,
        // One remembered folder for everything Imp saves.
        id: 'imp-files',
        startIn: 'downloads',
        ...(extension === null
          ? {}
          : {
              types: [
                {
                  description: request.description ?? t('File'),
                  accept: { [request.mediaType.split(';')[0] ?? request.mediaType]: [extension] },
                },
              ],
            }),
      });
    } catch (error) {
      if (isAbort(error)) return { saved: false };
      // Refused (no click to go on, a policy, an unusual type): downloads still work.
      handle = null;
    }
  }
  if (handle === null) {
    const content = await make();
    downloadFile(await toBlob(content, request.mediaType), request.suggestedName);
    return { saved: true, name: request.suggestedName, where: 'downloads' };
  }
  let writable: WritableFile | null = null;
  try {
    const content = await make();
    writable = await handle.createWritable();
    if (content instanceof Blob) await writable.write(content);
    else if (isBytes(content)) await writable.write(content.slice());
    else for await (const piece of content) await writable.write(piece.slice());
    await writable.close();
    return { saved: true, name: handle.name, where: 'picked' };
  } catch (error) {
    // Nothing is written until close; the empty file the dialog made goes too, where it can.
    await writable?.abort().catch(() => undefined);
    await handle.remove?.().catch(() => undefined);
    throw error;
  }
}

/** A file name for `text` that every system accepts, as the core names its files. */
export function fileSafe(text: string, fallback: string): string {
  return (
    text
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback
  );
}
