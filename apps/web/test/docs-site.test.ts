import type { GuideTopic } from '@imp/core';
import { describe, expect, it } from 'vitest';
import { docsSite } from '../src/docs/site.js';

const topics: GuideTopic[] = [
  {
    id: 'getting-started',
    area: 'workspace',
    title: 'Getting started',
    summary: 'What Imp is.',
    body: 'Tell the **coordinator** your story.\n\n## Steps\n\n1. Write\n2. Film\n\n- a <b>tag</b>\n- `code`',
  },
  {
    id: 'stage-edit',
    area: 'edit',
    title: 'Edit',
    summary: 'Join clips.',
    body: 'Drag a dissolve.',
  },
];

describe('the docs site', () => {
  it('has an index, a page per guide page and a style sheet, and escapes what pages say', () => {
    const files = docsSite(topics);
    expect([...files.keys()].sort()).toEqual([
      'getting-started.html',
      'index.html',
      'stage-edit.html',
      'style.css',
    ]);
    const page = files.get('getting-started.html') ?? '';
    expect(page).toContain('<strong>coordinator</strong>');
    expect(page).toContain('<h2>Steps</h2>');
    expect(page).toContain('<ol><li>Write</li><li>Film</li></ol>');
    expect(page).toContain('a &lt;b&gt;tag&lt;/b&gt;');
    expect(page).toContain('<code>code</code>');
    expect(page).toContain('aria-current="page">Getting started');
    expect(files.get('index.html')).toContain('href="stage-edit.html"');
  });
});
