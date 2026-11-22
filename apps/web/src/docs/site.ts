import type { GuideTopic } from '@imp/core';
import { parseGuide } from '../app/help/guide-format.js';

/**
 * The docs site: the in-app guide as static pages, written into the build
 * beside the app, so the help is readable and searchable on the web without
 * any server. It is generated from the same pages as the help panel, so the
 * two never disagree.
 */

const ISSUES = 'https://github.com/ArndRosemeier/Imp/issues/new';

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** **bold** and `code`, after escaping, so nothing in a page can add markup. */
function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function bodyHtml(body: string): string {
  return parseGuide(body)
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return `<h2>${inline(block.text)}</h2>`;
        case 'paragraph':
          return `<p>${inline(block.text)}</p>`;
        case 'bullets':
          return `<ul>${block.items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`;
        case 'steps':
          return `<ol>${block.items.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`;
      }
    })
    .join('\n');
}

const STYLE = `
:root {
  color-scheme: dark light;
  --ground: #0e0d0b; --surface: #171512; --line: #2a2622;
  --ink: #ede6da; --ink-soft: #c9bfaf; --ink-muted: #a39a8b; --accent: #e8a33d;
  --display: 'Instrument Serif', 'Iowan Old Style', Georgia, serif;
  --body: 'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --ground: #f6f2ea; --surface: #fffdf8; --line: #e2dacb;
    --ink: #1b1814; --ink-soft: #453e35; --ink-muted: #6b6257; --accent: #9a5b00;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.65 var(--body); }
a { color: var(--accent); text-underline-offset: 3px; }
.top { display: flex; align-items: center; gap: 24px; padding: 16px clamp(16px, 4vw, 48px); border-bottom: 1px solid var(--line); }
.brand { font: 28px/1 var(--display); color: var(--ink); text-decoration: none; }
.brand span { color: var(--accent); font-style: italic; }
.top nav { margin-left: auto; display: flex; gap: 20px; font-size: 14px; }
.top nav a { color: var(--ink-soft); text-decoration: none; }
.top nav a:hover { color: var(--accent); }
.layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: clamp(24px, 4vw, 64px); max-width: 1180px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 80px; }
.index { position: sticky; top: 24px; align-self: start; font-size: 14px; }
.index h3 { margin: 24px 0 8px; font: 600 11px/1 var(--body); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); }
.index ul { list-style: none; margin: 0; padding: 0; }
.index a { display: block; padding: 7px 12px; border-radius: 8px; color: var(--ink-soft); text-decoration: none; }
.index a:hover { background: var(--surface); color: var(--ink); }
.index a[aria-current='page'] { background: var(--surface); color: var(--accent); }
article { max-width: 720px; }
.eyebrow { font: 600 11px/1 var(--body); letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
h1 { margin: 12px 0 8px; font: 400 clamp(40px, 6vw, 60px)/1.05 var(--display); letter-spacing: -0.01em; }
.summary { margin: 0 0 32px; font-size: 19px; color: var(--ink-soft); }
article h2 { margin: 40px 0 8px; font: 400 30px/1.2 var(--display); }
article li { margin: 6px 0; }
code { padding: 1px 6px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); font: 0.88em ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-top: 32px; }
.card { display: block; padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--ink); text-decoration: none; }
.card:hover { border-color: var(--accent); }
.card strong { display: block; font: 400 22px/1.2 var(--display); margin-bottom: 6px; }
.card span { color: var(--ink-muted); font-size: 14px; }
.foot { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--line); color: var(--ink-muted); font-size: 14px; }
@media (max-width: 760px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .index { position: static; }
}
`;

function fileOf(topic: GuideTopic): string {
  return topic.id === 'getting-started' ? 'getting-started.html' : `${topic.id}.html`;
}

function frame(
  title: string,
  description: string,
  topics: readonly GuideTopic[],
  current: string | null,
  main: string,
): string {
  const group = (label: string, list: readonly GuideTopic[]): string =>
    list.length === 0
      ? ''
      : `<h3>${label}</h3><ul>${list
          .map(
            (topic) =>
              `<li><a href="${fileOf(topic)}"${topic.id === current ? ' aria-current="page"' : ''}>${escape(topic.title)}</a></li>`,
          )
          .join('')}</ul>`;
  const workspace = topics.filter((topic) => topic.area === 'workspace');
  const stages = topics.filter((topic) => topic.area !== 'workspace');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="index.html"><span>i</span> Imp guide</a>
  <nav>
    <a href="../index.html">Open Imp</a>
    <a href="${ISSUES}" target="_blank" rel="noreferrer">Report a problem</a>
  </nav>
</header>
<div class="layout">
  <nav class="index" aria-label="Guide pages">
    <ul><li><a href="index.html"${current === null ? ' aria-current="page"' : ''}>All pages</a></li></ul>
    ${group('Imp', workspace)}
    ${group('Stages', stages)}
  </nav>
  <article>
${main}
    <p class="foot">This is the same guide as the Help panel inside Imp, where you can also ask Imp in your own words.</p>
  </article>
</div>
</body>
</html>
`;
}

/** Every file of the docs site, by path inside the `docs/` folder. */
export function docsSite(topics: readonly GuideTopic[]): Map<string, string> {
  const files = new Map<string, string>();
  files.set('style.css', STYLE.trimStart());
  const cards = topics
    .map(
      (topic) =>
        `<a class="card" href="${fileOf(topic)}"><strong>${escape(topic.title)}</strong><span>${escape(topic.summary)}</span></a>`,
    )
    .join('\n');
  files.set(
    'index.html',
    frame(
      'Imp guide',
      'How to make films with Imp: every stage, the AI crew, costs and help.',
      topics,
      null,
      `    <span class="eyebrow">Guide</span>
    <h1>Make films with Imp</h1>
    <p class="summary">Imp makes films of any length from AI-generated pictures, voices, sound and video clips. Start with Getting started, or jump to a stage.</p>
    <div class="grid">${cards}</div>`,
    ),
  );
  for (const topic of topics) {
    files.set(
      fileOf(topic),
      frame(
        `${topic.title} · Imp guide`,
        topic.summary,
        topics,
        topic.id,
        `    <span class="eyebrow">${topic.area === 'workspace' ? 'Imp' : 'Stage'}</span>
    <h1>${escape(topic.title)}</h1>
    <p class="summary">${inline(topic.summary)}</p>
${bodyHtml(topic.body)}`,
      ),
    );
  }
  return files;
}
