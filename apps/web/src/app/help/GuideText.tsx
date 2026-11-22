import type { ReactElement, ReactNode } from 'react';
import { RichText } from '../RichText.js';

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'steps'; items: string[] };

const STEP = /^\d+\. /;

/** Reads the guide's small Markdown subset into blocks. Never HTML, so nothing can inject markup. */
export function parseGuide(body: string): Block[] {
  const blocks: Block[] = [];
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

/** One page of the guide, laid out for reading. */
export function GuideText({ body }: { body: string }): ReactElement {
  const nodes: ReactNode[] = parseGuide(body).map((block, index) => {
    switch (block.kind) {
      case 'heading':
        return <h3 key={index}>{block.text}</h3>;
      case 'paragraph':
        return (
          <p key={index}>
            <RichText text={block.text} />
          </p>
        );
      case 'bullets':
        return (
          <ul key={index}>
            {block.items.map((item, at) => (
              <li key={at}>
                <RichText text={item} />
              </li>
            ))}
          </ul>
        );
      case 'steps':
        return (
          <ol key={index}>
            {block.items.map((item, at) => (
              <li key={at}>
                <RichText text={item} />
              </li>
            ))}
          </ol>
        );
    }
  });
  return <div className="guide-text">{nodes}</div>;
}
