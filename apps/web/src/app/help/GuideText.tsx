import type { ReactElement, ReactNode } from 'react';
import { RichText } from '../RichText.js';
import { parseGuide } from './guide-format.js';

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
