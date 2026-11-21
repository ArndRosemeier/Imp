import type { FilmPicture, FilmRenderer, FilmRenderJob, FilmRendered } from '@imp/mode-movie';
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
  type VideoCodec,
} from 'mediabunny';
import { chooseFormat, fadeLevel } from './film-format.js';
import { drawText, drawTexts } from './text-draw.js';
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
  const shade = (picture: FilmPicture, t: number): void => {
    const since = t - picture.startSeconds;
    const level = fadeLevel(
      picture.fadeInSeconds,
      picture.fadeOutSeconds,
      since,
      picture.durationSeconds - since,
    );
    if (level < 1) {
      g.fillStyle = `rgba(0, 0, 0, ${String(1 - level)})`;
      g.fillRect(0, 0, width, height);
    }
  };
  /** The frames of the film that fall within a picture, by their times. */
  const framesOf = (picture: FilmPicture): number => {
    const end = Math.min(
      totalFrames,
      Math.round((picture.startSeconds + picture.durationSeconds) * fps),
    );
    return Math.max(0, end - frame);
  };

  await loadTextFonts();
  try {
    await output.start();
    for (const picture of pictures) {
      // Black wherever nothing is on screen.
      while (frame < totalFrames && frame / fps < picture.startSeconds - 0.5 / fps) {
        black();
        await emit();
      }
      const count = framesOf(picture);
      if (count === 0) continue;
      if (picture.kind === 'title') {
        for (let i = 0; i < count; i++) {
          black();
          // The card's own words, set in the title style; they fade with the card.
          drawText(
            g,
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
          shade(picture, frame / fps);
          await emit();
        }
        continue;
      }
      const bytes = unreadable.has(picture.blobKey) ? undefined : await job.clip(picture.blobKey);
      const input = bytes === undefined ? undefined : openClip(bytes);
      try {
        const track = await input?.getPrimaryVideoTrack();
        const first = frame;
        const times = Array.from(
          { length: count },
          (_, i) => picture.sourceStartSeconds + (first + i) / fps - picture.startSeconds,
        );
        const samples =
          track === null || track === undefined
            ? undefined
            : new VideoSampleSink(track).samplesAtTimestamps(times);
        for (let i = 0; i < count; i++) {
          const next = samples === undefined ? undefined : await samples.next();
          const sample = next === undefined || next.done === true ? null : next.value;
          black();
          if (sample !== null) {
            const scale = Math.min(width / sample.displayWidth, height / sample.displayHeight);
            const w = sample.displayWidth * scale;
            const h = sample.displayHeight * scale;
            sample.draw(g, (width - w) / 2, (height - h) / 2, w, h);
            sample.close();
          }
          shade(picture, frame / fps);
          await emit();
        }
        await samples?.return();
      } finally {
        input?.dispose();
      }
    }
    while (frame < totalFrames) {
      black();
      await emit();
    }
    await soundUntil(plan.durationSeconds);
    video.close();
    sound.close();
    await output.finalize();
  } catch (error) {
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
