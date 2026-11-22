import type { FilmExport } from '@imp/mode-movie';

/**
 * The ready films a text names, by id or by file name. A file name that
 * several films share means the newest of them, so `films` must come newest
 * first, as movie.edit.export.list gives them.
 */
export function filmsMentioned(text: string, films: readonly FilmExport[]): FilmExport[] {
  if (text === '') return [];
  const found: FilmExport[] = [];
  const names = new Set<string>();
  for (const film of films) {
    if (film.status !== 'ready') continue;
    const byName = !names.has(film.fileName) && text.includes(film.fileName);
    names.add(film.fileName);
    if (text.includes(film.id) || byName) found.push(film);
  }
  return found;
}

/**
 * Where in a conversation each film gets its card: under the last message
 * that names it, so that the card sits with the reply that reports the film.
 * `texts[index]` is everything message `index` said and got back.
 */
export function filmCardPlaces(
  texts: readonly string[],
  films: readonly FilmExport[],
): Map<number, FilmExport[]> {
  const last = new Map<string, { index: number; film: FilmExport }>();
  texts.forEach((text, index) => {
    for (const film of filmsMentioned(text, films)) last.set(film.id, { index, film });
  });
  const places = new Map<number, FilmExport[]>();
  for (const { index, film } of last.values()) {
    places.set(index, [...(places.get(index) ?? []), film]);
  }
  return places;
}
