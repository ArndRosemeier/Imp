import type { FrameGrabber } from '@imp/mode-movie';
import { ALL_FORMATS, BufferSource, Input, VideoSampleSink } from 'mediabunny';

/**
 * Takes stills from a clip with the browser's own video decoders (WebCodecs,
 * through mediabunny), for agents to look at. Undefined where the browser
 * cannot (no OffscreenCanvas or WebCodecs), so that reads go on without pictures.
 */
export function createFrameGrabber(scope: object = globalThis): FrameGrabber | undefined {
  if (!('OffscreenCanvas' in scope) || !('VideoDecoder' in scope)) return undefined;
  return async (video, atSeconds, width) => {
    const input = new Input({ source: new BufferSource(video.bytes), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (track === null) return atSeconds.map(() => undefined);
      const stills = [];
      for await (const sample of new VideoSampleSink(track).samplesAtTimestamps(atSeconds)) {
        if (sample === null) {
          stills.push(undefined);
          continue;
        }
        try {
          const height = Math.max(
            2,
            Math.round((width * sample.displayHeight) / sample.displayWidth / 2) * 2,
          );
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext('2d');
          if (context === null) {
            stills.push(undefined);
            continue;
          }
          sample.draw(context, 0, 0, width, height);
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
          stills.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mediaType: 'image/jpeg' });
        } finally {
          sample.close();
        }
      }
      return stills;
    } finally {
      input.dispose();
    }
  };
}
