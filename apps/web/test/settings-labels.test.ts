import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERNAL_SETTINGS, SETTING_LABELS, settingLabel } from '../src/app/settings-labels.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * Every setting key the code stores or reads, found the ways the code names
 * them: a `settings/<key>` path, a key passed to settings.set or settings.get,
 * or a string constant used inside a `settings/` path.
 */
function settingKeys(): Set<string> {
  const files = ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(root, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, top, entry.name, 'src')),
  );
  const texts = files
    .flatMap((dir) => {
      try {
        return sources(dir);
      } catch {
        return [];
      }
    })
    .map((file) =>
      // Comments name example keys; only code counts.
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    );
  const keys = new Set<string>();
  const constants = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/const (\w+) = '([a-z][\w.-]*)'/g)) {
      constants.set(match[1] ?? '', match[2] ?? '');
    }
  }
  for (const text of texts) {
    for (const match of text.matchAll(/['`]settings\/([a-z][\w.-]*)['`]/g))
      keys.add(match[1] ?? '');
    for (const match of text.matchAll(/'settings\.(?:set|get)',\s*\{\s*key:\s*'([^']+)'/g)) {
      keys.add(match[1] ?? '');
    }
    // `settings/${NAME}` or `${SETTINGS}${NAME}`, where NAME is a string constant.
    for (const match of text.matchAll(/(?:settings\/|\$\{\w*SETTINGS\w*\})\$\{(\w+)\}/g)) {
      const value = constants.get(match[1] ?? '');
      if (value !== undefined) keys.add(value);
    }
  }
  return keys;
}

describe('setting labels', () => {
  it('finds the settings the code uses', () => {
    const keys = settingKeys();
    for (const known of ['coordinator.model', 'video.model', 'help.dismissed', 'project.current']) {
      expect(keys).toContain(known);
    }
  });

  it('names every setting in words or keeps it internal, so no raw key reaches Settings', () => {
    const unnamed = [...settingKeys()].filter(
      (key) => SETTING_LABELS[key] === undefined && !INTERNAL_SETTINGS.has(key),
    );
    expect(unnamed).toEqual([]);
  });

  it('turns an unknown key into words', () => {
    expect(settingLabel('video.model')).toBe('Video model');
    expect(settingLabel('some.new_thing')).toBe('Some new thing');
  });
});
