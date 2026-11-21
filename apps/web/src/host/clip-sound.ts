import { sniffAudioFormat, UnsupportedAudioError, type AudioCodec } from '@imp/audio';
import { ALL_FORMATS, AudioSampleSink, BufferSource, Input } from 'mediabunny';

/**
 * Adds the sound inside video clips (AAC in MP4) to a codec, decoded by the
 * browser through WebCodecs. Every other format goes to the codec it wraps.
 * No AAC decoder ships with Imp: the only WebAssembly one is under the GPL.
 */
export function withClipSound(base: AudioCodec): AudioCodec {
  return {
    async decode(bytes, mediaType) {
      if (sniffAudioFormat(bytes) !== 'mp4' || typeof AudioDecoder === 'undefined') {
        return base.decode(bytes, mediaType);
      }
      const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (track === null) throw new UnsupportedAudioError('mp4', 'This clip has no sound.');
        if (!(await track.canDecode())) {
          throw new UnsupportedAudioError(
            'mp4',
            `This browser cannot decode the sound of this clip (${(await track.getCodec()) ?? 'unknown codec'}).`,
          );
        }
        const channels = Math.max(1, await track.getNumberOfChannels());
        const sampleRate = await track.getSampleRate();
        const pieces: Float32Array[][] = Array.from({ length: channels }, () => []);
        let frames = 0;
        for await (const sample of new AudioSampleSink(track).samples()) {
          for (let channel = 0; channel < channels; channel++) {
            const plane = new Float32Array(sample.numberOfFrames);
            sample.copyTo(plane, {
              planeIndex: Math.min(channel, sample.numberOfChannels - 1),
              format: 'f32-planar',
            });
            pieces[channel]?.push(plane);
          }
          frames += sample.numberOfFrames;
          sample.close();
        }
        const joined = pieces.map((list) => {
          const out = new Float32Array(frames);
          let at = 0;
          for (const piece of list) {
            out.set(piece, at);
            at += piece.length;
          }
          return out;
        });
        return { sampleRate, channels: joined };
      } finally {
        input.dispose();
      }
    },
  };
}
