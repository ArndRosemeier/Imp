import { ListedAsset } from '@imp/core';
import { z } from 'zod';
import { fixed, t } from '../../i18n/i18n.js';

/** An asset as the library shows it: in a list its text may be only the start. */
export type Asset = ListedAsset;

const Facet = z.object({ id: z.string(), label: z.string(), count: z.number() });

export const Listing = z.object({
  assets: z.array(ListedAsset),
  total: z.number(),
  facets: z.object({
    modalities: z.array(Facet),
    kinds: z.array(Facet.extend({ modality: z.string() })),
    tags: z.array(Facet),
  }),
});
export type Listing = z.infer<typeof Listing>;

/** The window event that asks a view to show one thing; its detail is an OpenTarget. */
export const FOCUS_EVENT = 'imp:focus';
/** The window event that sends the person to another view; its detail is the view's id. */
export const OPEN_VIEW = 'imp:open-view';

export interface Focus {
  readonly view: string;
  readonly focus: Readonly<Record<string, string>>;
}

/** Sends the person to where an asset is made, and tells that view what to show. */
export function openWhereMade(target: Focus): void {
  window.dispatchEvent(new CustomEvent(OPEN_VIEW, { detail: target.view }));
  // After the view has mounted, so it can listen.
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: target }));
  }, 0);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const whole = Math.round(seconds);
  if (whole < 60)
    return t('{value} s', { value: seconds < 10 ? fixed(seconds, 1) : String(whole) });
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}
