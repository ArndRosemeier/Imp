import type { ReactElement } from 'react';

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

/**
 * Renders the two inline marks models use most, bold and code, and leaves
 * everything else as plain text. It builds elements and never sets HTML, so
 * model output cannot inject markup.
 */
export function RichText({ text }: { text: string }): ReactElement {
  return (
    <>
      {text.split(INLINE).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return part;
      })}
    </>
  );
}
