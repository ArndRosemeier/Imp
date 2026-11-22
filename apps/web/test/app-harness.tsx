// Shared set-up for the App workflow tests. They are split over several files so
// that the test runner can walk them in parallel.
import { MemoryKeyValueStore, type ReleaseNotes } from '@imp/core';
import type { FilmRenderer } from '@imp/mode-movie';
import type { ModelInfo } from '@imp/providers';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll } from 'vitest';
import { App } from '../src/app/App.js';
import { connectImp, createImp, createLocalPorts, serveImp, type Imp } from '@imp/host';
import { createLocalSecretStore } from '../src/host/secrets.js';

export const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id,
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextLength: 1000,
  supportsTools: true,
  pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
  ...extra,
});

/** The interface reaches the core only through messages, as it does with a worker. */
export function connect(imp: Imp): ReturnType<typeof connectImp> {
  const [page, core] = createLocalPorts();
  serveImp(() => imp, core);
  return connectImp(page, imp.secrets);
}

export interface Started {
  readonly imp: Imp;
  readonly provider: ReturnType<typeof createFakeProvider>;
  readonly user: ReturnType<typeof userEvent.setup>;
}

export function start(
  replies: readonly ScriptedChatReply[] = [],
  release?: ReleaseNotes,
  filmRenderer?: FilmRenderer,
): Started {
  const provider = createFakeProvider({
    replies,
    models: [
      model('vendor/writer'),
      model('~vendor/latest'),
      model('vendor/painter', { outputModalities: ['image'] }),
      model('vendor/speaker', { outputModalities: ['speech'] }),
      model('vendor/clips', { outputModalities: ['video'] }),
      model('vendor/composer', { outputModalities: ['text', 'audio'] }),
      model('vendor/no-tools', { supportsTools: false }),
    ],
  });
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    secrets: createLocalSecretStore(),
    provider,
    ...(release === undefined ? {} : { release }),
    ...(filmRenderer === undefined ? {} : { filmRenderer }),
  });
  render(<App imp={connect(imp)} />);
  return { imp, provider, user: userEvent.setup() };
}

export async function completeSetup(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('OpenRouter API key'), 'sk-test');
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.type(await screen.findByLabelText(/Model/), 'vendor/writer');
  await user.click(screen.getByRole('button', { name: /Hire the coordinator/ }));
  await screen.findByRole('heading', { name: 'Projects' });
}

/** Fills in what jsdom lacks and cleans up after every test of the calling file. */
export function setUpAppTests(): void {
  beforeAll(() => {
    // jsdom implements neither scrolling nor the modal dialog methods.
    Element.prototype.scrollIntoView = () => undefined;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    // Nor does it play media.
    HTMLMediaElement.prototype.pause = () => undefined;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    // jsdom has no object URLs either.
    let urls = 0;
    URL.createObjectURL = () => `blob:test/${String((urls += 1))}`;
    URL.revokeObjectURL = () => undefined;
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });
}

/** Opens a model picker and picks the model with the given id from its searchable list. */
export async function chooseModel(
  user: ReturnType<typeof userEvent.setup>,
  picker: HTMLElement,
  id: string,
): Promise<void> {
  await user.click(picker);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await user.click(await screen.findByRole('option', { name: new RegExp(escaped) }));
}
