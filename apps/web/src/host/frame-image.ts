import type { MediaInput } from '@imp/providers';

/**
 * Re-encodes a picture as JPEG with the browser's own decoders, for video
 * models that start a clip only on a JPEG or PNG frame while image models
 * often answer in WebP. Undefined where the browser cannot (no OffscreenCanvas).
 */
export async function toJpeg(image: MediaInput): Promise<MediaInput | undefined> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return undefined;
  }
  const bitmap = await createImageBitmap(
    new Blob([image.bytes.slice()], { type: image.mediaType }),
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) return undefined;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType: 'image/jpeg' };
}
