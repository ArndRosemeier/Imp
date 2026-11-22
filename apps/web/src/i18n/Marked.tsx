import { Fragment, type ReactElement } from 'react';

/**
 * A translated sentence with **bold** words in it. Translations move the bold
 * words wherever their language puts them, so the sentence is translated
 * whole rather than in pieces around the bold part.
 */
export function Marked({ text }: { text: string }): ReactElement {
  const parts = text.split('**');
  return (
    <>
      {parts.map((part, index) =>
        // Every second part sits between two markers.
        index % 2 === 1 ? (
          <strong key={index}>{part}</strong>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
