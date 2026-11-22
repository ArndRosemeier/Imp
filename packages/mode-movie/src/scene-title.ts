const SETTING =
  /^(?:INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E\.?|INT\.|EXT\.|INT\b|EXT\b)\s*/i;
const TIME_SPLIT = /(?:^|\s+)[-–—]\s+/;

/** "LAMP ROOM" reads as "Lamp Room"; mixed case is left as written. */
function plainCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/**
 * A scene's name short enough for a tab: "INT. SKERRIG LIGHTHOUSE, KITCHEN -
 * NIGHT" becomes "Kitchen, night". The place is the last part of the location,
 * the time of day follows it. A heading that is not a slug line stays as it is.
 */
export function shortSceneTitle(heading: string): string {
  const trimmed = heading.trim();
  if (trimmed === '') return 'Untitled';
  if (!SETTING.test(trimmed)) return trimmed;
  const [location = '', ...rest] = trimmed.replace(SETTING, '').split(TIME_SPLIT);
  const place = location.split(',').at(-1)?.trim() ?? '';
  const time = rest.join(' - ').trim();
  if (place === '') return time === '' ? trimmed : plainCase(time);
  return time === '' ? plainCase(place) : `${plainCase(place)}, ${time.toLowerCase()}`;
}
