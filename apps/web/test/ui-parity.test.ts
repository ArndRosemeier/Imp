import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryBlobStore, MemoryKeyValueStore } from '@imp/core';
import { createImp, createMemorySecretStore } from '@imp/host';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Anything an agent can change, a person can change in the app too (Arnd,
 * 2026-11-23: "I would like to know if there are more gaps in the UI, where
 * things can only be changed via chat"). This walks every command that
 * changes something and every option it takes, and fails when the app's
 * screens never use one. A command or option that is fine without a control
 * of its own goes in AGENT_ONLY, with the reason.
 */

const APP = join(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [readFileSync(path, 'utf8')] : [];
  });
}

/** Ids of the form world.<kind>.… are called with a template in the Design stage. */
function spelled(id: string): RegExp {
  const escaped = id.replace(/\./g, '\\.');
  const templated = id.replace(/^world\.(location|object)\./, 'world.${$KIND}.');
  const kind = templated
    .replace(/\./g, '\\.')
    .replace('$\\{$KIND\\}', '\\$\\{(?:element\\.)?kind\\}')
    .replace('${$KIND}', '\\$\\{(?:element\\.)?kind\\}');
  return new RegExp(`['\`](?:${escaped}|${kind})['\`]`);
}

/** The options of a command: the keys of its input object, wrappers taken off. */
function optionsOf(schema: z.ZodType): string[] {
  let current: unknown = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject) return Object.keys(current.shape);
    const def = (current as { def?: { innerType?: unknown; in?: unknown; schema?: unknown } }).def;
    const next = def?.innerType ?? def?.in ?? def?.schema;
    if (next === undefined) return [];
    current = next;
  }
  return [];
}

/** Options every command takes or the app fills in for the person, never a choice. */
const ALWAYS = new Set(['projectId', 'sceneId', 'docId', 'id']);

/**
 * Commands and options with no control of their own, and why that is right.
 * Keep this short: each entry is something only an agent can do.
 */
const AGENT_ONLY: Readonly<Record<string, string>> = {
  // Effect cards in the Audio editor build a chain and set it whole with audio.fx.set;
  // these are the same effects one at a time, for agents.
  'audio.fx.compressor': 'the effect cards, through audio.fx.set',
  'audio.fx.crush': 'the effect cards, through audio.fx.set',
  'audio.fx.distortion': 'the effect cards, through audio.fx.set',
  'audio.fx.eq': 'the effect cards, through audio.fx.set',
  'audio.fx.limiter': 'the effect cards, through audio.fx.set',
  'audio.fx.loudness': 'the effect cards, through audio.fx.set',
  'audio.fx.pitch': 'the effect cards, through audio.fx.set',
  'audio.fx.ringmod': 'the effect cards, through audio.fx.set',
  'audio.fx.remove': 'removing a card sets the chain without it, through audio.fx.set',
  'crew.ask maxSteps':
    'agents asking each other; a person’s chat uses the usual limit and Continue',
  'audio.normalize peakDb': 'the buttons normalize to the usual −1 dB',
  'audio.transcribe language': 'the language is heard from the speech',
  'movie.edit.line.record model': 'the voice model chosen in Settings or the stage’s model chip',
  'movie.edit.pickup.request performance': 'set on the new shot in the Shots stage',
  'movie.edit.pickup.request objects': 'set on the new shot in the Shots stage',
  'movie.edit.pickup.request line': 'set on the new shot in the Shots stage',
  'movie.edit.pickup.request delivery': 'set on the new shot in the Shots stage',
  'world.location.create firstView': 'the Design stage adds views right after',
  'world.location.create firstViewDescription': 'the Design stage adds views right after',
  'world.object.create firstView': 'the Design stage adds views right after',
  'world.object.create firstViewDescription': 'the Design stage adds views right after',
  // Pictures are made in the shape their use needs: key frames and views in the
  // film's 16:9, portraits upright. Open question for Arnd whether people should pick.
  'movie.character.image.generate aspectRatio': 'portraits are made upright (3:4)',
  'world.location.image.generate aspectRatio': 'views are made in the film’s shape',
  'world.object.image.generate aspectRatio': 'object pictures are made square',
};

function gaps(): string[] {
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    secrets: createMemorySecretStore(),
    provider: createFakeProvider({}),
  });
  const files = sources(APP);
  const found: string[] = [];
  for (const command of imp.registry.list()) {
    if (command.effect === 'read') continue;
    if (AGENT_ONLY[command.id] !== undefined) continue;
    const pattern = spelled(command.id);
    const using = files.filter((text) => pattern.test(text));
    if (using.length === 0) {
      found.push(command.id);
      continue;
    }
    for (const option of optionsOf(command.input)) {
      if (ALWAYS.has(option) || /Id$|Ids$/.test(option)) continue;
      if (AGENT_ONLY[`${command.id} ${option}`] !== undefined) continue;
      const word = new RegExp(`\\b${option}\\b`);
      if (!using.some((text) => word.test(text))) found.push(`${command.id} ${option}`);
    }
  }
  return found;
}

describe('everything an agent can change, the app can change', () => {
  it('has a control for every command and option, or says why not', () => {
    expect(gaps()).toEqual([]);
  });
});
