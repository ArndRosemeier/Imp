import { versionNumber } from './WhatsNew.js';

/** The file every build publishes next to its page, naming its version. */
export const VERSION_FILE = 'version.json';

/** How often an open Imp asks whether a newer version has been published. */
export const CHECK_EVERY_MS = 15 * 60 * 1000;

/** The newer version published, or null when this one is current or the answer is unclear. */
export function newerVersion(running: string, published: unknown): string | null {
  if (typeof published !== 'object' || published === null) return null;
  const version = (published as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^\d+\.\d{3}$/.test(version)) return null;
  return versionNumber(version) > versionNumber(running) ? version : null;
}

/** Asks the site, past every cache, which version it publishes now. */
export async function fetchPublishedVersion(running: string): Promise<string | null> {
  const url = new URL(VERSION_FILE, location.href);
  url.searchParams.set('t', String(Date.now()));
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) return null;
  return newerVersion(running, await response.json());
}

/**
 * Keeps installed copies current. The service worker makes every launch fetch
 * the page fresh; it is only used where Imp is served as a website, because
 * the local server already tells the browser never to keep the page.
 */
export function registerUpdater(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
    // Without it Imp still works; the update notice then covers installed copies.
  });
}

/**
 * Loads the newest version: refreshes the browser's stored copy of the page
 * first, so later launches from the home screen open it too, then reloads.
 */
export async function loadNewestVersion(): Promise<void> {
  try {
    await fetch(new URL('./', location.href), { cache: 'reload' });
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    }
  } catch {
    // Reloading below still asks for the page.
  }
  location.reload();
}
