/** A title broken into lines that fit the width. */
export function wrapLines(text: string, fits: (line: string) => boolean): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((part) => part !== '')) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && !fits(next)) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}
