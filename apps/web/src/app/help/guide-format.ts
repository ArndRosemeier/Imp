/** The guide's small Markdown subset, shared by the help panel and the docs site built from it. */

export type GuideBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'steps'; items: string[] };

const STEP = /^\d+\. /;

/** Reads the guide's small Markdown subset into blocks. Never HTML, so nothing can inject markup. */
export function parseGuide(body: string): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length === 0) continue;
    const first = lines[0] ?? '';
    if (first.startsWith('## ')) {
      blocks.push({ kind: 'heading', text: first.slice(3) });
      const rest = lines.slice(1).join('\n');
      if (rest !== '') blocks.push(...parseGuide(rest));
    } else if (lines.every((line) => line.startsWith('- '))) {
      blocks.push({ kind: 'bullets', items: lines.map((line) => line.slice(2)) });
    } else if (lines.every((line) => STEP.test(line))) {
      blocks.push({ kind: 'steps', items: lines.map((line) => line.replace(STEP, '')) });
    } else {
      blocks.push({ kind: 'paragraph', text: lines.join(' ') });
    }
  }
  return blocks;
}
