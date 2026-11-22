import { useId, type ReactElement } from 'react';

/** Imp's mark: an italic i whose dot has horns and whose tail ends in a barb. The same glyph as the app icon. */
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
        <path d="M298 338 Q324 326 350 302 Q338 330 336 364 Q330 350 320 346 Z" />
        <circle cx="300" cy="152" r="31" />
        <path d="M278 142 C258 126 252 102 262 78 C270 100 284 116 298 124 Z" />
        <path d="M322 142 C342 126 348 102 338 78 C330 100 316 116 302 124 Z" />
      </g>
    </svg>
  );
}
