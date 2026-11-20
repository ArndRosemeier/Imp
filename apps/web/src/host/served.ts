/**
 * True when the local server delivered this page. It marks the page it
 * serves, so the interface knows without asking whether a core is waiting
 * for it or it has to start one of its own.
 */
export function servedByLocalServer(): boolean {
  return document.querySelector('meta[name="imp-host"]')?.getAttribute('content') === 'server';
}
