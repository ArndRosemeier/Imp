/**
 * How a piece of the picture maps its own time to the time of its clip, with
 * the rescue tools applied: speed, playing backwards, holding its last frame,
 * and a punch-in (a zoom into the frame, still or moving). Pure functions, so
 * that the Edit preview, the film renderer, the stills agents look at and the
 * sound all agree on what is seen and heard when.
 */

/** What a piece needs for its timing. */
export interface PieceTiming {
  /** Seconds the clip runs, before trims. */
  readonly sourceSeconds: number;
  readonly trimStartSeconds: number;
  readonly trimEndSeconds: number;
  /** 1 plays as filmed; 0.5 at half speed; 2 at double speed. */
  readonly speed: number;
  readonly reverse: boolean;
  /** Seconds the last frame is held after the piece has played. */
  readonly holdSeconds: number;
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** The seconds of the clip a piece uses, between its trims. */
export const usedSeconds = (piece: PieceTiming): number =>
  Math.max(0, piece.sourceSeconds - piece.trimStartSeconds - piece.trimEndSeconds);

/** How long the piece moves on screen: its used stretch at its speed. */
export const movingSeconds = (piece: PieceTiming): number =>
  round(usedSeconds(piece) / (piece.speed > 0 ? piece.speed : 1));

/** How long the piece is on screen: moving, then holding its last frame. */
export const pieceSeconds = (piece: PieceTiming): number =>
  usedSeconds(piece) <= 0 ? 0 : round(movingSeconds(piece) + piece.holdSeconds);

/** Whether the piece's own sound can play with it: only at its own speed, forwards. */
export const playsOwnSound = (piece: Pick<PieceTiming, 'speed' | 'reverse'>): boolean =>
  piece.speed === 1 && !piece.reverse;

/** A frame's length, to stay inside the clip when its last frame is shown. */
const LAST_FRAME = 1 / 60;

/** The time in the clip that is on screen a number of seconds into the piece. */
export function sourceTime(piece: PieceTiming, seconds: number): number {
  const used = usedSeconds(piece);
  const start = piece.trimStartSeconds;
  const end = piece.trimStartSeconds + used;
  const into = Math.min(Math.max(0, seconds), movingSeconds(piece)) * piece.speed;
  const t = piece.reverse ? end - into : start + into;
  // The last frame stays inside the clip, where a decoder still has a picture.
  return Math.min(Math.max(t, start), Math.max(start, end - LAST_FRAME));
}

/** Where a piece is split, in the clip: the trims each half gets. */
export function splitTrims(
  piece: PieceTiming,
  atSeconds: number,
): {
  first: { trimStartSeconds: number; trimEndSeconds: number };
  second: { trimStartSeconds: number; trimEndSeconds: number };
} {
  const used = usedSeconds(piece);
  const consumed = Math.min(used, Math.max(0, atSeconds * piece.speed));
  if (piece.reverse) {
    // Backwards, the first half shows the end of the stretch and the second its start.
    return {
      first: {
        trimStartSeconds: round(piece.trimStartSeconds + used - consumed),
        trimEndSeconds: piece.trimEndSeconds,
      },
      second: {
        trimStartSeconds: piece.trimStartSeconds,
        trimEndSeconds: round(piece.trimEndSeconds + consumed),
      },
    };
  }
  return {
    first: {
      trimStartSeconds: piece.trimStartSeconds,
      trimEndSeconds: round(piece.trimEndSeconds + used - consumed),
    },
    second: {
      trimStartSeconds: round(piece.trimStartSeconds + consumed),
      trimEndSeconds: piece.trimEndSeconds,
    },
  };
}

/** A punch-in: how far a piece is zoomed and on which point of its frame. */
export interface Punch {
  /** 1 shows the whole frame; 2 shows half its width. */
  readonly zoom: number;
  /** The zoom at the end of the piece, for a slow push in or pull out; null keeps zoom. */
  readonly zoomTo: number | null;
  /** The point zoomed on, as shares of the frame's width and height. */
  readonly focusX: number;
  readonly focusY: number;
}

/** The zoom of a piece at a share of its time on screen, eased in and out. */
export function zoomAt(punch: Punch, share: number): number {
  if (punch.zoomTo === null || punch.zoomTo === punch.zoom) return punch.zoom;
  const t = Math.min(1, Math.max(0, share));
  const eased = t * t * (3 - 2 * t);
  return punch.zoom + (punch.zoomTo - punch.zoom) * eased;
}

/** Where a picture is drawn in a frame: fitted whole, then zoomed on its focus. */
export interface Placed {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where to draw a picture of a size in a frame so that it fits whole and is
 * zoomed on a point. The picture never pulls away from the frame's edges it
 * covers, so a punch-in never shows black beside the picture.
 */
export function placePicture(
  frameWidth: number,
  frameHeight: number,
  pictureWidth: number,
  pictureHeight: number,
  zoom: number,
  focusX: number,
  focusY: number,
): Placed {
  const fit = Math.min(frameWidth / pictureWidth, frameHeight / pictureHeight);
  const scale = fit * Math.max(1, zoom);
  const width = pictureWidth * scale;
  const height = pictureHeight * scale;
  const along = (frame: number, size: number, focus: number): number => {
    if (size <= frame) return (frame - size) / 2;
    // Bring the focus to the middle of the frame, as far as the picture's edges allow.
    const wanted = frame / 2 - focus * size;
    return Math.min(0, Math.max(frame - size, wanted));
  };
  return {
    x: along(frameWidth, width, focusX),
    y: along(frameHeight, height, focusY),
    width,
    height,
  };
}
