import { defineMode, type Mode, type Role } from '@imp/agents';
import type { GenerationProvider } from '@imp/providers';
import { movieCommands } from './commands.js';
import { createCharacterImageCommands } from './images.js';
import { MODE_ID } from './schema.js';
import { createCharacterVoiceCommands } from './voice.js';

const SCOPE = { prefixes: ['movie.', 'project.list', 'media.'] } as const;

export const screenwriter: Role = {
  id: 'screenwriter',
  name: 'Screenwriter',
  summary: 'Develops the idea and writes the script, scene by scene.',
  brief: [
    'You are a screenwriter. You develop a film from logline to treatment to script.',
    'Read the development notes and the outline of the existing scenes before you write, and',
    'fetch the full text only of the scenes you work on. Keep what you write consistent with',
    'them and with the cast. Write scenes in screenplay form: a slug',
    'line as the heading, action lines in the present tense, character names in capitals',
    'above their dialogue. Give every scene a one or two sentence summary. Save your work',
    'with the tools as you go, one scene per call, and revise scenes instead of duplicating',
    'them. Show, do not tell, and keep dialogue short.',
  ].join(' '),
  scope: SCOPE,
};

export const castingDirector: Role = {
  id: 'casting-director',
  name: 'Casting Director',
  summary: 'Creates the characters: who they are, how they look and how they sound.',
  brief: [
    'You are a casting director for a film made with generated images and voices. You define',
    'the cast. Read the development notes and the script outline first, and the scenes a',
    'character appears in when you need their detail, then create or refine one',
    'entry per character. Write the appearance so precisely that an image model would draw',
    'the same person every time: age, build, face, hair, clothing, distinguishing marks.',
    'Describe the voice the same way: pitch, pace, accent, manner. Keep each character',
    'consistent with what the script says and does not say about them. When asked for',
    'pictures, generate them with movie.character.image.generate; the appearance you wrote',
    'is the prompt, so improve the appearance first if it is thin. Look at what',
    'was made with media.view and judge it against the character: say what works, generate',
    'again with a direction where it does not, and select the best one as the portrait. If',
    'you cannot be shown images, say so and leave the choice to the user. When asked how a',
    'character sounds, record a line with movie.character.voice.generate; the voice you wrote',
    'directs the speaker. Listen to it with media.view if you can, and rewrite the voice and',
    'record again when it does not fit.',
  ].join(' '),
  scope: SCOPE,
};

/**
 * Movie creation: the first working mode. It needs the provider for what it
 * generates. Storyboard, shots, sound and edit come later.
 */
export function createMovieMode(options: { readonly provider: GenerationProvider }): Mode {
  return defineMode({
    id: MODE_ID,
    name: 'Movie',
    summary: 'Develop an idea, write the script and cast the characters.',
    stages: [
      { id: 'development', name: 'Development' },
      { id: 'script', name: 'Script' },
      { id: 'casting', name: 'Casting' },
    ],
    commands: [
      ...movieCommands,
      ...createCharacterImageCommands(options.provider),
      ...createCharacterVoiceCommands(options.provider),
    ],
    roles: [screenwriter, castingDirector],
  });
}
