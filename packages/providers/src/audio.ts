// MPEG audio layer III, the one format speech comes back in. Tables from the standard.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * How long an MP3 plays, in seconds, by walking its frames. The player of the
 * page knows this too, but the core has to know it before anything is shown,
 * for example to make a clip long enough for a spoken line. Null when the
 * bytes are not MP3.
 */
export function mp3DurationSeconds(bytes: Uint8Array): number | null {
  let at = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // The tag's size is stored in seven bits of each byte.
    at =
      10 +
      (((bytes[6] ?? 0) & 0x7f) << 21) +
      (((bytes[7] ?? 0) & 0x7f) << 14) +
      (((bytes[8] ?? 0) & 0x7f) << 7) +
      ((bytes[9] ?? 0) & 0x7f);
  }
  let seconds = 0;
  let frames = 0;
  while (at + 4 <= bytes.length) {
    const [b0 = 0, b1 = 0, b2 = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[b2 >> 4];
    const rate = SAMPLE_RATES[version]?.[(b2 >> 2) & 3];
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0 || layer !== 1 || !bitrate || !rate) {
      // Not a frame: padding, a tag or damage. Look at the next byte.
      at += 1;
      continue;
    }
    const samples = version === 3 ? 1152 : 576;
    at += Math.floor(((samples / 8) * bitrate * 1000) / rate) + ((b2 >> 1) & 1);
    seconds += samples / rate;
    frames += 1;
  }
  return frames === 0 ? null : seconds;
}
