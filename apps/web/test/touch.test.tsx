// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePinchZoom } from '../src/app/gestures.js';
import { OrientationNotice } from '../src/app/OrientationNotice.js';
import { followVisualViewport } from '../src/app/viewport.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

/** A `matchMedia` whose answers the test sets, and changes later. */
function stubMedia(initial: Record<string, boolean>) {
  const answers = { ...initial };
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return answers[query] ?? false;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (query: string, matches: boolean) => {
    answers[query] = matches;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
}

const UPRIGHT = '(pointer: coarse) and (orientation: portrait)';
const SMALL = '(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 559px)';

describe('the orientation notice', () => {
  it('stays away on a computer and a tablet held sideways', () => {
    stubMedia({});
    render(<OrientationNotice />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks to turn an upright tablet, and leaves once it is turned', () => {
    const set = stubMedia({ [UPRIGHT]: true });
    render(<OrientationNotice />);
    expect(screen.getByRole('alertdialog', { name: 'Turn your tablet sideways' })).toBeTruthy();
    set(UPRIGHT, false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says a phone is too small, and can be dismissed for the visit', async () => {
    stubMedia({ [SMALL]: true, [UPRIGHT]: true });
    render(<OrientationNotice />);
    expect(screen.getByRole('alertdialog', { name: 'Imp needs a bigger screen' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue anyway' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sessionStorage.getItem('imp.orientation.dismissed')).toBe('true');
  });
});

/** A touch event with the given fingers; jsdom has no `Touch` to build real ones. */
function touch(type: string, fingers: readonly [number, number][]): Event {
  const event = new Event(type, { cancelable: true });
  const touches = fingers.map(([clientX, clientY]) => ({ clientX, clientY }));
  Object.defineProperty(event, 'touches', { value: Object.assign(touches, { item: undefined }) });
  return event;
}

function Pinchable({ onZoom }: { onZoom: (factor: number, x: number) => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  usePinchZoom(ref, onZoom);
  return <div ref={ref} data-testid="area" />;
}

describe('pinch zoom', () => {
  it('reports how far the fingers spread and where their middle is', () => {
    const onZoom = vi.fn();
    render(<Pinchable onZoom={onZoom} />);
    const area = screen.getByTestId('area');

    // One finger is a scroll or a drag, not a pinch.
    const scroll = touch('touchmove', [[10, 0]]);
    area.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);

    const first = touch('touchmove', [
      [100, 0],
      [200, 0],
    ]);
    area.dispatchEvent(first);
    // The page itself must not zoom.
    expect(first.defaultPrevented).toBe(true);
    expect(onZoom).not.toHaveBeenCalled();
    area.dispatchEvent(
      touch('touchmove', [
        [50, 0],
        [250, 0],
      ]),
    );
    expect(onZoom).toHaveBeenLastCalledWith(2, 150);

    // Lifting a finger ends the pinch; the next one starts from its own spread.
    area.dispatchEvent(touch('touchend', [[50, 0]]));
    area.dispatchEvent(
      touch('touchmove', [
        [0, 0],
        [100, 0],
      ]),
    );
    expect(onZoom).toHaveBeenCalledTimes(1);
  });
});

describe('the visible height', () => {
  function fakeWindow(height: number, scale = 1) {
    const listeners = new Set<() => void>();
    const viewport = {
      height,
      scale,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    const scrollTo = vi.fn();
    const target = {
      visualViewport: viewport,
      document,
      scrollY: 0,
      scrollTo,
    } as unknown as Window & { scrollY: number };
    return {
      target,
      viewport,
      scrollTo,
      resize: () => {
        for (const listener of listeners) listener();
      },
    };
  }
  const height = () => document.documentElement.style.getPropertyValue('--app-height');

  it('follows the on-screen keyboard but not pinch zoom', () => {
    const { target, viewport, scrollTo, resize } = fakeWindow(834);
    const stop = followVisualViewport(target);
    expect(height()).toBe('834px');

    // The keyboard opens and iPadOS scrolls the page to the field.
    viewport.height = 480;
    target.scrollY = 120;
    resize();
    expect(height()).toBe('480px');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    // Zoomed in twice: the visible part is half as tall, the layout is not.
    viewport.height = 417;
    viewport.scale = 2;
    scrollTo.mockClear();
    resize();
    expect(height()).toBe('834px');
    expect(scrollTo).not.toHaveBeenCalled();

    stop();
    expect(height()).toBe('');
  });

  it('does nothing where there is no visual viewport', () => {
    const stop = followVisualViewport({ visualViewport: null } as unknown as Window);
    stop();
    expect(height()).toBe('');
  });
});
