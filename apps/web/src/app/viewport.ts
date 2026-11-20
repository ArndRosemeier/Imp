/**
 * Keeps `--app-height` equal to the part of the window that is really visible.
 *
 * On a tablet, the on-screen keyboard covers the lower part of the page without
 * making the layout smaller (iPadOS Safari), so a composer or dialog at the
 * bottom would end up under the keys. Sizing the app to the visual viewport
 * keeps what is being typed into in view.
 */
export function followVisualViewport(target: Window = window): () => void {
  const viewport = target.visualViewport;
  if (viewport === null) return () => undefined;
  const root = target.document.documentElement;
  const update = (): void => {
    // Times the zoom, so pinch-zooming in does not shrink the layout; only the keyboard does.
    const height = Math.round(viewport.height * viewport.scale);
    root.style.setProperty('--app-height', `${String(height)}px`);
    // iPadOS scrolls the whole page to reveal a focused field; the app is
    // already sized to fit, so take that scroll back.
    if (viewport.scale === 1 && target.scrollY !== 0) target.scrollTo(0, 0);
  };
  update();
  viewport.addEventListener('resize', update);
  return () => {
    viewport.removeEventListener('resize', update);
    root.style.removeProperty('--app-height');
  };
}
