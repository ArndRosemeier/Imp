import type { VideoPricing, VideoPrice } from '../types.js';

const RESOLUTION = /_(\d{3,4}p|[248]k)$/i;

/**
 * Reads OpenRouter's price list of a video model (`pricing_skus`). Models are
 * priced per second of video (in dollars or cents, by size, with or without
 * sound) or per video token; anything else, such as prices for video input or
 * long clips, is left out.
 */
export function parseVideoPricing(
  skus: Readonly<Record<string, string>> | null | undefined,
): VideoPricing | undefined {
  if (skus === null || skus === undefined) return undefined;
  const perSecond: VideoPrice[] = [];
  const perToken: VideoPrice[] = [];
  let minimumUsd: number | undefined;
  for (const [rawKey, rawValue] of Object.entries(skus)) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) continue;
    if (rawKey === 'minimum_cents_per_generation') {
      minimumUsd = value / 100;
      continue;
    }
    if (rawKey.includes('input') || rawKey.startsWith('long_') || rawKey.includes('continuation')) {
      continue;
    }
    const match = RESOLUTION.exec(rawKey);
    const resolution = match?.[1]?.toLowerCase() ?? null;
    let key = match === null ? rawKey : rawKey.slice(0, match.index);
    let audio: boolean | null = null;
    if (key.endsWith('_with_audio')) {
      audio = true;
      key = key.slice(0, -'_with_audio'.length);
    } else if (key.endsWith('_without_audio')) {
      audio = false;
      key = key.slice(0, -'_without_audio'.length);
    }
    if (key === 'duration_seconds') {
      perSecond.push({ resolution, audio, usd: value });
    } else if (key === 'cents_per_video_output_second' || key === 'cents_per_second_output') {
      perSecond.push({ resolution, audio, usd: value / 100 });
    } else if (key === 'video_tokens') {
      perToken.push({ resolution, audio, usd: value });
    }
  }
  if (perSecond.length === 0 && perToken.length === 0) return undefined;
  return {
    perSecond,
    perToken,
    ...(minimumUsd === undefined ? {} : { minimumUsd }),
  };
}
