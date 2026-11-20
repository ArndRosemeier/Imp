import { defineMode, type Role } from '@imp/agents';
import { movieCommands } from './commands.js';
import { MODE_ID } from './schema.js';

const SCOPE = { prefixes: ['movie.', 'project.list'] } as const;

export const screenwriter: Role = {
  id: 'screenwriter',
  name: 'Screenwriter',
  summary: 'Develops the idea and writes the script, scene by scene.',
  brief: [
    'You are a screenwriter. You develop a film from logline to treatment to script.',
    'Read the development notes and the existing scenes before you write, and keep what you',
    'write consistent with them and with the cast. Write scenes in screenplay form: a slug',
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
    'the cast. Read the development notes and the script first, then create or refine one',
    'entry per character. Write the appearance so precisely that an image model would draw',
    'the same person every time: age, build, face, hair, clothing, distinguishing marks.',
    'Describe the voice the same way: pitch, pace, accent, manner. Keep each character',
    'consistent with what the script says and does not say about them.',
  ].join(' '),
  scope: SCOPE,
};

/** Movie creation: the first working mode. Storyboard, shots, sound and edit come later. */
export const movieMode = defineMode({
  id: MODE_ID,
  name: 'Movie',
  summary: 'Develop an idea, write the script and cast the characters.',
  stages: [
    { id: 'development', name: 'Development' },
    { id: 'script', name: 'Script' },
    { id: 'casting', name: 'Casting' },
  ],
  commands: movieCommands,
  roles: [screenwriter, castingDirector],
});
