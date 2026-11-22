// Drawing a film's picture, shared by the browser's renderer and the local server's.
export { chooseFormat, fadeLevel, nearestRate } from './film-format.js';
export {
  drawLane,
  drawText,
  drawTexts,
  TEXT_FAMILIES,
  type DrawnText,
  type LaneText,
  type TextCanvas,
} from './text-draw.js';
export { wrapLines } from './title-lines.js';
