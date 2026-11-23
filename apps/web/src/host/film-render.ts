import {
  applyMatrix,
  placePicture,
  shadeAt,
  sourceTime,
  transitionShare,
  zoomAt,
  type FilmPicture,
  type FilmRenderer,
  type FilmRenderJob,
  type FilmRendered,
} from '@imp/mode-movie';
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferSource,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSampleSink,
  type StreamTargetChunk,
  type VideoSample,
  type VideoCodec,
} from 'mediabunny';
import { chooseFormat, drawText, drawTexts } from '@imp/host/film';
import { framesInOrder } from './frame-order.js';
import { loadTextFonts } from './text-fonts.js';

/** The engine's sound: 48 kHz stereo, as @imp/audio mixes it. */
const RATE = 48_000;
/** Sound is mixed and encoded half a second at a time, kept a little ahead of the picture. */
const AUDIO_BLOCK = RATE / 2;
const HIGH = new Quality('high');
const VIDEO_CODECS: readonly VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1'];

const openClip = (bytes: Uint8Array): Input =>
  new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

class Cancelled extends Error {
  constructor() {
    super('The render was cancelled.');
  }
}

async function render(job: FilmRenderJob): Promise<FilmRendered> {
  const { plan } = job;
  const pictures = [...plan.pictures].sort((a, b) => a.startSeconds - b.startSeconds);

  // What the clips are: their size and rate decide the film's, unless they were asked for.
  const probed: { width: number; height: number; fps: number; seconds: number }[] = [];
  const unreadable = new Set<string>();
  for (const key of new Set(pictures.flatMap((p) => (p.kind === 'clip' ? [p.blobKey] : [])))) {
    const bytes = await job.clip(key);
    const input = bytes === undefined ? undefined : openClip(bytes);
    try {
      const track = await input?.getPrimaryVideoTrack();
      if (track === null || track === undefined || !(await track.canDecode())) {
        unreadable.add(key);
        continue;
      }
      const stats = await track.computePacketStats(60);
      const seconds = pictures
        .filter((p) => p.kind === 'clip' && p.blobKey === key)
        .reduce((sum, p) => sum + p.durationSeconds, 0);
      probed.push({
        width: await track.getDisplayWidth(),
        height: await track.getDisplayHeight(),
        fps: stats.averagePacketRate > 0 ? stats.averagePacketRate : 30,
        seconds,
      });
    } finally {
      input?.dispose();
    }
  }
  // The stills, decoded once each: they set no size of their own unless there are no clips.
  const stills = new Map<string, ImageBitmap>();
  for (const key of new Set(pictures.flatMap((p) => (p.kind === 'still' ? [p.blobKey] : [])))) {
    const bytes = await job.clip(key);
    if (bytes === undefined) continue;
    try {
      stills.set(key, await createImageBitmap(new Blob([bytes as BlobPart])));
    } catch {
      // A picture the browser cannot read stays black, like a clip it cannot decode.
    }
  }
  if (probed.length === 0) {
    for (const still of stills.values()) {
      probed.push({ width: still.width, height: still.height, fps: 24, seconds: 1 });
    }
  }
  const format = chooseFormat(probed, plan.height, plan.fps);
  const { width, height, fps } = format;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        write: (chunk) => job.write(chunk.data, chunk.position),
      }),
      { chunked: true, chunkSize: 4 * 1024 * 1024 },
    ),
  });
  const supported = output.format.getSupportedVideoCodecs();
  const videoCodec = await getFirstEncodableVideoCodec(
    VIDEO_CODECS.filter((codec) => supported.includes(codec)),
    { width, height },
  );
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: 2,
    sampleRate: RATE,
  });
  if (videoCodec === null) {
    throw new Error(`This browser cannot encode video at ${String(width)}×${String(height)}.`);
  }
  if (audioCodec === null) throw new Error('This browser cannot encode sound (AAC or Opus).');

  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: false });
  if (g === null) throw new Error('This browser cannot draw the picture of the film.');
  const video = new CanvasSource(canvas, {
    codec: videoCodec,
    quality: HIGH,
    keyFrameInterval: 2,
  });
  const sound = new AudioSampleSource({ codec: audioCodec, quality: HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(sound);

  const totalFrames = Math.max(1, Math.round(plan.durationSeconds * fps));
  const totalSamples = Math.round(plan.durationSeconds * RATE);
  let samplesDone = 0;
  let frame = 0;

  const check = (): void => {
    if (job.cancelled()) throw new Cancelled();
  };
  const soundUntil = async (seconds: number): Promise<void> => {
    const target = Math.min(totalSamples, Math.round(seconds * RATE));
    while (samplesDone < target) {
      const count = Math.min(AUDIO_BLOCK, target - samplesDone);
      const [left, right] = await job.mix(samplesDone, count);
      const data = new Float32Array(count * 2);
      data.set(left.subarray(0, count), 0);
      data.set(right.subarray(0, count), count);
      const sample = new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate: RATE,
        timestamp: samplesDone / RATE,
      });
      await sound.add(sample);
      sample.close();
      samplesDone += count;
    }
  };
  const texts = plan.texts ?? [];
  const emit = async (): Promise<void> => {
    // The text lane lies over everything, fades to black included.
    drawTexts(g, texts, frame / fps, width, height);
    await video.add(frame / fps, 1 / fps);
    frame += 1;
    await soundUntil(frame / fps + 0.5);
    job.progress(frame / fps);
    check();
  };
  const black = (): void => {
    g.globalAlpha = 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, width, height);
  };
  /** Each picture is drawn whole here first, then laid on the frame: over the last one in a dissolve or wipe. */
  const scratch = new OffscreenCanvas(width, height);
  const layer = scratch.getContext('2d', { alpha: false, willReadFrequently: true });
  if (layer === null) throw new Error('This browser cannot draw the picture of the film.');

  /** A picture on screen: the frames of the film it covers and, for a clip, its decoded frames. */
  interface Layer {
    readonly picture: FilmPicture;
    readonly end: number;
    readonly frames?: AsyncGenerator<VideoSample | null, void, undefined>;
    readonly input?: Input | undefined;
  }
  const open = async (picture: FilmPicture, first: number, end: number): Promise<Layer> => {
    if (picture.kind === 'title' || picture.kind === 'still') return { picture, end };
    const bytes = unreadable.has(picture.blobKey) ? undefined : await job.clip(picture.blobKey);
    const input = bytes === undefined ? undefined : openClip(bytes);
    const track = await input?.getPrimaryVideoTrack();
    if (track === null || track === undefined) return { picture, end, input };
    const timing = picture.timing ?? {
      sourceSeconds: picture.sourceStartSeconds + picture.durationSeconds,
      trimStartSeconds: picture.sourceStartSeconds,
      trimEndSeconds: 0,
      speed: 1,
      reverse: false,
      holdSeconds: 0,
    };
    // The time of the clip on screen at each frame: speed, reverse and a held frame applied.
    const times = Array.from({ length: Math.max(0, end - first) }, (_, i) =>
      sourceTime(timing, (first + i) / fps - picture.startSeconds),
    );
    const sink = new VideoSampleSink(track);
    const frames = framesInOrder(
      times,
      (rising) => sink.samplesAtTimestamps(rising),
      (sample) => {
        sample.close();
      },
    );
    return { picture, end, frames, input };
  };
  const shut = async (open: Layer): Promise<void> => {
    await open.frames?.return();
    open.input?.dispose();
  };

  /** Draws a picture as it is at a time onto the scratch canvas: black, the picture, its fades and dips. */
  const paint = async (on: Layer, t: number): Promise<void> => {
    const { picture } = on;
    const since = t - picture.startSeconds;
    layer.globalAlpha = 1;
    layer.fillStyle = '#000';
    layer.fillRect(0, 0, width, height);
    if (picture.kind === 'title') {
      // The card's own words, set in the title style; they fade with the card.
      drawText(
        layer,
        {
          kind: 'title',
          text: picture.text,
          style: { ...picture.style, enter: 'cut', exit: 'cut', roll: false },
          startSeconds: 0,
          durationSeconds: picture.durationSeconds,
          x: null,
          y: null,
        },
        0,
        width,
        height,
      );
    } else if (picture.kind === 'still') {
      const still = stills.get(picture.blobKey);
      if (still !== undefined) {
        const at = placePicture(width, height, still.width, still.height, 1, 0.5, 0.5);
        layer.drawImage(still, at.x, at.y, at.width, at.height);
        if (picture.matrix !== undefined) {
          const pixels = layer.getImageData(0, 0, width, height);
          applyMatrix(pixels.data, picture.matrix);
          layer.putImageData(pixels, 0, 0);
        }
      }
    } else {
      const next = on.frames === undefined ? undefined : await on.frames.next();
      const sample = next === undefined || next.done === true ? null : next.value;
      if (sample !== null) {
        const punch = picture.punch ?? { zoom: 1, zoomTo: null, focusX: 0.5, focusY: 0.5 };
        const zoom = zoomAt(
          punch,
          picture.durationSeconds > 0 ? since / picture.durationSeconds : 0,
        );
        const at = placePicture(
          width,
          height,
          sample.displayWidth,
          sample.displayHeight,
          zoom,
          punch.focusX,
          punch.focusY,
        );
        sample.draw(layer, at.x, at.y, at.width, at.height);
        if (picture.matrix !== undefined) {
          // Its grade and the film's look, on the pixels, before fades and dips lie over it.
          const pixels = layer.getImageData(0, 0, width, height);
          applyMatrix(pixels.data, picture.matrix);
          layer.putImageData(pixels, 0, 0);
        }
      }
    }
    const { black, white } = shadeAt(
      {
        fadeInSeconds: picture.fadeInSeconds,
        fadeOutSeconds: picture.fadeOutSeconds,
        dipIn: picture.dipIn ?? null,
        dipOut: picture.dipOut ?? null,
      },
      since,
      picture.durationSeconds,
    );
    if (black > 0) {
      layer.fillStyle = `rgba(0, 0, 0, ${String(black)})`;
      layer.fillRect(0, 0, width, height);
    }
    if (white > 0) {
      layer.fillStyle = `rgba(255, 255, 255, ${String(white)})`;
      layer.fillRect(0, 0, width, height);
    }
  };

  /** Lays the scratch canvas on the frame: whole, or partly over the picture before. */
  const lay = (picture: FilmPicture, t: number): void => {
    const into = picture.transitionIn;
    const share = into === undefined ? 1 : transitionShare(into.seconds, t - picture.startSeconds);
    g.save();
    if (into?.kind === 'wipe' && share < 1) {
      g.beginPath();
      g.rect(0, 0, width * share, height);
      g.clip();
    } else {
      g.globalAlpha = share;
    }
    g.drawImage(scratch, 0, 0);
    g.restore();
  };

  await loadTextFonts();
  const layers: Layer[] = [];
  try {
    await output.start();
    let next = 0;
    while (frame < totalFrames) {
      // Pictures come on at their first frame; two are on screen while one dissolves into the next.
      while (next < pictures.length) {
        const picture = pictures[next];
        if (picture === undefined) break;
        const first = Math.round(picture.startSeconds * fps);
        if (first > frame) break;
        next++;
        const end = Math.min(
          totalFrames,
          Math.round((picture.startSeconds + picture.durationSeconds) * fps),
        );
        if (end > frame) layers.push(await open(picture, frame, end));
      }
      const t = frame / fps;
      black();
      for (const on of layers) {
        await paint(on, t);
        lay(on.picture, t);
      }
      await emit();
      for (const on of layers.filter((candidate) => candidate.end <= frame)) {
        await shut(on);
        layers.splice(layers.indexOf(on), 1);
      }
    }
    await soundUntil(plan.durationSeconds);
    video.close();
    sound.close();
    await output.finalize();
  } catch (error) {
    for (const on of layers) await shut(on);
    await output.cancel();
    throw error;
  }
  return {
    mediaType: 'video/mp4',
    extension: 'mp4',
    videoCodec: videoCodec,
    audioCodec,
    width,
    height,
    fps,
  };
}

/**
 * Renders films in the browser worker with WebCodecs: each frame is drawn on
 * an OffscreenCanvas from the decoded clips, encoded, and muxed into an MP4
 * with the mixed sound. No screen, no playback, and faster than real time.
 */
export function createFilmRenderer(): FilmRenderer {
  return {
    unavailable: () =>
      typeof VideoEncoder === 'undefined' ||
      typeof AudioEncoder === 'undefined' ||
      typeof VideoDecoder === 'undefined' ||
      typeof OffscreenCanvas === 'undefined'
        ? 'This browser cannot render video offline (it has no WebCodecs). Use a current Chrome, Edge or Safari, or record the cut in real time on the Edit screen.'
        : null,
    render,
  };
}
