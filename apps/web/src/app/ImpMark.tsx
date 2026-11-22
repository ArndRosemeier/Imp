import { useId, type ReactElement } from 'react';

/**
 * Imp's mark: an italic i whose dot has horns and whose tail ends in a barb.
 * The same glyph as the app icon. The horns and the barb are their own
 * groups, so the stylesheet can make them twitch and flick (see `.imp-mark`).
 */
export function ImpMark({ height = 30 }: { readonly height?: number }): ReactElement {
  const gold = useId();
  return (
    <svg
      className="imp-mark"
      width={height / 2}
      height={height}
      viewBox="190 70 180 360"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gold} gradientUnits="userSpaceOnUse" x1="0" y1="80" x2="0" y2="414">
          <stop offset="0" stopColor="var(--mark-top)" />
          <stop offset="0.55" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--mark-bottom)" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gold})`}>
        <path d="M300 190 L262 360 C258 378 264 386 276 382 C290 376 302 360 312 340 L322 346 C306 384 280 412 248 412 C218 412 206 392 212 364 L240 240 C242 230 238 226 226 230 L222 222 C248 206 276 192 300 190 Z" />
        <path
          className="imp-mark-barb"
          d="M298 338 Q324 326 350 302 Q338 330 336 364 Q330 350 320 346 Z"
        />
        <g className="imp-mark-head">
          <circle cx="300" cy="152" r="31" />
          <path
            className="imp-mark-horn"
            d="M278 142 C258 126 252 102 262 78 C270 100 284 116 298 124 Z"
          />
          <path
            className="imp-mark-horn imp-mark-horn-right"
            d="M322 142 C342 126 348 102 338 78 C330 100 316 116 302 124 Z"
          />
        </g>
      </g>
    </svg>
  );
}

/**
 * Imp's busy sign: the imp's tail chasing itself, an arc that ends in the
 * mark's barb. It replaces a plain "Working" wherever something takes a
 * moment. Screen readers get the label from the surrounding text.
 */
export function ImpSpinner({ size = 18 }: { readonly size?: number }): ReactElement {
  return (
    <svg
      className="imp-spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path className="imp-spinner-track" d="M12 4 A8 8 0 1 1 4 12.4" />
      <path className="imp-spinner-barb" d="M4 5.4 L7.5 12.6 L4 10.9 L0.5 12.6 Z" />
    </svg>
  );
}

/**
 * A round badge with the imp's horns, for an icon that stands for a whole
 * empty stage. The icon sits in the middle; the horns peek over the rim.
 */
export function HornedBadge({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <span className="horned-badge">
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        {/* The mark's horns, small and set a little apart to sit on the rim. */}
        <g transform="translate(27 22) scale(0.34) translate(-300 -152)">
          <path
            className="horned-badge-horn"
            d="M278 142 C258 126 252 102 262 78 C270 100 284 116 298 124 Z"
          />
        </g>
        <g transform="translate(37 22) scale(0.34) translate(-300 -152)">
          <path
            className="horned-badge-horn horned-badge-horn-right"
            d="M322 142 C342 126 348 102 338 78 C330 100 316 116 302 124 Z"
          />
        </g>
        <circle className="horned-badge-ring" cx="32" cy="38" r="24" />
      </svg>
      <span className="horned-badge-icon">{children}</span>
    </span>
  );
}
