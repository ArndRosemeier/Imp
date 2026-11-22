/**
 * Shapes into coverage masks, without a canvas: outlines (straight edges and
 * curves) are filled with exact anti-aliasing by accumulating the signed area
 * each edge sweeps through a pixel. Pure JavaScript, so the local server needs
 * no native module to draw the texts of a film.
 */

/** A coverage mask: one value from 0 (empty) to 1 (covered) per pixel. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export type PathCommand =
  | { readonly type: 'M' | 'L'; readonly x: number; readonly y: number }
  | {
      readonly type: 'Q';
      readonly x1: number;
      readonly y1: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: 'C';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly type: 'Z' };

/** Fills outlines into a mask of a size; the outlines are in the mask's pixels. */
export class Rasterizer {
  readonly #area: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    // One cell more than the mask: an edge on the last column spills into it.
    this.#area = new Float32Array(width * height + 2);
  }

  /** Adds the closed outlines of a path (contours close by themselves). */
  path(commands: readonly PathCommand[]): void {
    let startX = 0;
    let startY = 0;
    let x = 0;
    let y = 0;
    for (const command of commands) {
      switch (command.type) {
        case 'M':
          if (x !== startX || y !== startY) this.line(x, y, startX, startY);
          startX = x = command.x;
          startY = y = command.y;
          break;
        case 'L':
          this.line(x, y, command.x, command.y);
          x = command.x;
          y = command.y;
          break;
        case 'Q': {
          const steps = curveSteps(x, y, command.x1, command.y1, command.x, command.y);
          let px = x;
          let py = y;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const u = 1 - t;
            const qx = u * u * x + 2 * u * t * command.x1 + t * t * command.x;
            const qy = u * u * y + 2 * u * t * command.y1 + t * t * command.y;
            this.line(px, py, qx, qy);
            px = qx;
            py = qy;
          }
          x = command.x;
          y = command.y;
          break;
        }
        case 'C': {
          const steps = curveSteps(x, y, command.x1, command.y1, command.x2, command.y2) * 2;
          let px = x;
          let py = y;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const u = 1 - t;
            const a = u * u * u;
            const b = 3 * u * u * t;
            const c = 3 * u * t * t;
            const d = t * t * t;
            const cx = a * x + b * command.x1 + c * command.x2 + d * command.x;
            const cy = a * y + b * command.y1 + c * command.y2 + d * command.y;
            this.line(px, py, cx, cy);
            px = cx;
            py = cy;
          }
          x = command.x;
          y = command.y;
          break;
        }
        case 'Z':
          this.line(x, y, startX, startY);
          x = startX;
          y = startY;
          break;
      }
    }
    if (x !== startX || y !== startY) this.line(x, y, startX, startY);
  }

  /** Adds one edge. Edges outside the mask's columns are pulled to its border. */
  line(ax: number, ay: number, bx: number, by: number): void {
    const maxX = this.width - 1.0001;
    const x0 = Math.min(maxX, Math.max(0, ax));
    const x1 = Math.min(maxX, Math.max(0, bx));
    if (Math.abs(ay - by) < 1e-9) return;
    const down = ay < by;
    const dir = down ? 1 : -1;
    const top = { x: down ? x0 : x1, y: down ? ay : by };
    const bottom = { x: down ? x1 : x0, y: down ? by : ay };
    const dxdy = (bottom.x - top.x) / (bottom.y - top.y);
    let x = top.x;
    if (top.y < 0) x -= top.y * dxdy;
    const area = this.#area;
    const width = this.width;
    const first = Math.max(0, Math.floor(top.y));
    const last = Math.min(this.height, Math.ceil(bottom.y));
    for (let row = first; row < last; row++) {
      const start = row * width;
      const dy = Math.min(row + 1, bottom.y) - Math.max(row, top.y);
      const next = x + dxdy * dy;
      const d = dy * dir;
      const left = Math.min(x, next);
      const right = Math.max(x, next);
      const leftFloor = Math.floor(left);
      const leftCell = leftFloor;
      const rightCeil = Math.ceil(right);
      const rightCell = rightCeil;
      if (rightCell <= leftCell + 1) {
        const middle = 0.5 * (x + next) - leftFloor;
        area[start + leftCell] = (area[start + leftCell] ?? 0) + d - d * middle;
        area[start + leftCell + 1] = (area[start + leftCell + 1] ?? 0) + d * middle;
      } else {
        const s = 1 / (right - left);
        const leftFraction = left - leftFloor;
        const a0 = 0.5 * s * (1 - leftFraction) * (1 - leftFraction);
        const rightFraction = right - rightCeil + 1;
        const am = 0.5 * s * rightFraction * rightFraction;
        area[start + leftCell] = (area[start + leftCell] ?? 0) + d * a0;
        if (rightCell === leftCell + 2) {
          area[start + leftCell + 1] = (area[start + leftCell + 1] ?? 0) + d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - leftFraction);
          area[start + leftCell + 1] = (area[start + leftCell + 1] ?? 0) + d * (a1 - a0);
          for (let cell = leftCell + 2; cell < rightCell - 1; cell++) {
            area[start + cell] = (area[start + cell] ?? 0) + d * s;
          }
          const a2 = a1 + (rightCell - leftCell - 3) * s;
          area[start + rightCell - 1] = (area[start + rightCell - 1] ?? 0) + d * (1 - a2 - am);
        }
        area[start + rightCell] = (area[start + rightCell] ?? 0) + d * am;
      }
      x = next;
    }
  }

  /** The coverage of everything added, by the non-zero rule. */
  mask(): Mask {
    const data = new Float32Array(this.width * this.height);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += this.#area[i] ?? 0;
      data[i] = Math.min(1, Math.abs(sum));
    }
    return { width: this.width, height: this.height, data };
  }
}

/** How many straight pieces a curve is drawn with: enough that no piece is long. */
function curveSteps(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const length = Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by);
  return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(length) * 1.5)));
}

/** The outline of a rectangle with rounded corners, as a path. */
export function roundRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): PathCommand[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const commands: PathCommand[] = [];
  const corner = (cx: number, cy: number, from: number): void => {
    const steps = Math.max(2, Math.ceil(r / 2));
    for (let i = 0; i <= steps; i++) {
      const angle = from + (i / steps) * (Math.PI / 2);
      commands.push({
        type: commands.length === 0 ? 'M' : 'L',
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
      });
    }
  };
  corner(x + width - r, y + r, -Math.PI / 2);
  corner(x + width - r, y + height - r, 0);
  corner(x + r, y + height - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  commands.push({ type: 'Z' });
  return commands;
}

/**
 * Grows a mask by a radius in every direction, as a round pen does: each
 * pixel takes the largest coverage within the radius around it.
 */
export function dilate(mask: Mask, radius: number): Mask {
  if (radius <= 0) return mask;
  const { width, height, data } = mask;
  const out = new Float32Array(data.length);
  const reach = Math.ceil(radius);
  const offsets: { dx: number; dy: number; weight: number }[] = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      // Partial weight on the rim keeps the grown edge smooth.
      const weight = Math.min(1, Math.max(0, radius + 1 - Math.hypot(dx, dy)));
      if (weight > 0) offsets.push({ dx, dy, weight });
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = 0;
      for (const { dx, dy, weight } of offsets) {
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const value = (data[sy * width + sx] ?? 0) * weight;
        if (value > best) {
          best = value;
          if (best >= 1) break;
        }
      }
      out[y * width + x] = best;
    }
  }
  return { width, height, data: out };
}

/** Shrinks a mask by a radius: the inverse of growing the empty part. */
export function erode(mask: Mask, radius: number): Mask {
  if (radius <= 0) return mask;
  const inverse = { ...mask, data: mask.data.map((value) => 1 - value) };
  const grown = dilate(inverse, radius);
  return { ...grown, data: grown.data.map((value) => 1 - value) };
}

/** Blurs a mask with a Gaussian of a standard deviation, by three box blurs each way. */
export function blur(mask: Mask, sigma: number): Mask {
  if (sigma <= 0.25) return mask;
  const { width, height } = mask;
  // Box sizes whose three passes approximate the Gaussian (Kovesi).
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4),
  );
  const sizes = [0, 1, 2].map((i) => (i < m ? lower : upper));
  const data = new Float32Array(mask.data);
  const spare = new Float32Array(data.length);
  for (const size of sizes) {
    const r = (size - 1) / 2;
    boxPass(data, spare, width, height, r, true);
    boxPass(spare, data, width, height, r, false);
  }
  return { width, height, data };
}

function boxPass(
  from: Float32Array,
  to: Float32Array,
  width: number,
  height: number,
  r: number,
  across: boolean,
): void {
  const lines = across ? height : width;
  const length = across ? width : height;
  const at = (line: number, i: number): number => (across ? line * width + i : i * width + line);
  const scale = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      if (i >= 0 && i < length) sum += from[at(line, i)] ?? 0;
    }
    for (let i = 0; i < length; i++) {
      to[at(line, i)] = sum * scale;
      const leaving = i - r;
      const entering = i + r + 1;
      if (leaving >= 0) sum -= from[at(line, leaving)] ?? 0;
      if (entering < length) sum += from[at(line, entering)] ?? 0;
    }
  }
}
