import { DeviceRotateIcon, DesktopIcon } from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';
import { useMediaQuery } from './gestures.js';

const KEY = 'imp.orientation.dismissed';
/** A touch screen held upright. */
const UPRIGHT = '(pointer: coarse) and (orientation: portrait)';
/** A touch screen as small as a phone; phones held sideways are under 560 pixels tall. */
const SMALL = '(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 559px)';

/**
 * Imp is made for computers and for tablets held sideways. On a touch screen
 * held upright, or one the size of a phone, this covers the app with a short
 * explanation. Turning the tablet sideways makes it go away by itself, and it
 * can be dismissed for the rest of the visit.
 */
export function OrientationNotice(): ReactElement | null {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(KEY) === 'true');
  const small = useMediaQuery(SMALL);
  const upright = useMediaQuery(UPRIGHT);
  if (dismissed || !(small || upright)) return null;
  return (
    <div className="orientation-notice" role="alertdialog" aria-labelledby="orientation-title">
      <div className="orientation-card">
        {small ? (
          <>
            <DesktopIcon aria-hidden="true" size={56} weight="light" />
            <h2 id="orientation-title">Imp needs a bigger screen</h2>
            <p className="muted">
              Open Imp on a tablet held sideways or on a computer. Phones are too small for its
              editors.
            </p>
          </>
        ) : (
          <>
            <DeviceRotateIcon aria-hidden="true" size={56} weight="light" />
            <h2 id="orientation-title">Turn your tablet sideways</h2>
            <p className="muted">
              Imp lays out its stages, timeline and crew side by side, which needs a landscape
              screen.
            </p>
          </>
        )}
        <button
          className="button quiet"
          onClick={() => {
            sessionStorage.setItem(KEY, 'true');
            setDismissed(true);
          }}
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
