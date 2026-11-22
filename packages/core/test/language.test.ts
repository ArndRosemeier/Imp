import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  createHelpCommands,
  languageCommands,
  readLanguage,
  settingsCommands,
  type GuideTopic,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const english: GuideTopic = {
  id: 'costs',
  area: 'workspace',
  title: 'What things cost',
  summary: 'Prices.',
  body: 'A clip costs more than an edit.',
  hint: { title: 'Mind the price', body: 'Clips cost the most.' },
};
const german: GuideTopic = {
  ...english,
  title: 'Was es kostet',
  summary: 'Preise.',
  body: 'Ein Clip kostet mehr als ein Schnitt.',
  hint: { title: 'Achte auf den Preis', body: 'Clips kosten am meisten.' },
};

function setup(translations = { de: [german] }) {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...settingsCommands,
    ...languageCommands,
    ...createHelpCommands([english], translations),
  );
  const run = async (id: string, input: unknown): Promise<unknown> => {
    const result = await registry.executeById(id, input, {
      actor: { kind: 'agent', id: 'a', role: 'coordinator' },
    });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
  return { run, runtime };
}

describe('the interface language', () => {
  it('is English until someone chooses another', async () => {
    const { run, runtime } = setup();
    expect(await run('settings.language.get', {})).toMatchObject({ language: 'en' });
    expect(await readLanguage(runtime.store)).toBe('en');
  });

  it('can be switched by an agent, and is kept as a setting', async () => {
    const { run, runtime } = setup();
    expect(await run('settings.language.set', { language: 'de' })).toMatchObject({
      language: 'de',
    });
    expect(await readLanguage(runtime.store)).toBe('de');
    expect(await run('settings.get', { key: 'ui.language' })).toMatchObject({ value: 'de' });
  });

  it('takes only the languages Imp speaks', async () => {
    const { run } = setup();
    await expect(run('settings.language.set', { language: 'fr' })).rejects.toThrow();
  });

  it('shows guide pages and tips in the chosen language, or the one asked for', async () => {
    const { run } = setup();
    expect(await run('help.topic', { id: 'costs' })).toMatchObject({ title: 'What things cost' });
    expect(await run('help.topic', { id: 'costs', language: 'de' })).toMatchObject({
      title: 'Was es kostet',
    });
    await run('settings.language.set', { language: 'de' });
    expect(await run('help.topics', { query: 'Schnitt' })).toMatchObject({
      topics: [{ id: 'costs', title: 'Was es kostet' }],
    });
  });

  it('refuses a translation without its English page', () => {
    expect(() => setup({ de: [{ ...german, id: 'nowhere' }] })).toThrow();
  });
});
