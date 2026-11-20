import { z } from 'zod';

export const MODE_ID = 'movie';

/** What the film is, before there is a script. Every field starts empty. */
export const Development = z.object({
  logline: z.string().describe('The film in one or two sentences.'),
  premise: z.string().describe('The situation, the main character and what is at stake.'),
  tone: z.string().describe('Genre, mood and visual style.'),
  treatment: z.string().describe('The story told in prose from beginning to end.'),
});
export type Development = z.infer<typeof Development>;

export const EMPTY_DEVELOPMENT: Development = { logline: '', premise: '', tone: '', treatment: '' };

export const Scene = z.object({
  id: z.string(),
  /** Where the scene sits in the script, starting at 1. */
  position: z.number().int().positive(),
  heading: z.string().describe('The slug line, for example "INT. LIGHTHOUSE, LAMP ROOM - NIGHT".'),
  summary: z.string().describe('What happens in the scene, in a sentence or two.'),
  body: z.string().describe('The scene in screenplay form: action lines and dialogue.'),
});
export type Scene = z.infer<typeof Scene>;

export const Character = z.object({
  id: z.string(),
  name: z.string().min(1),
  part: z.string().describe('The role in the story, for example "protagonist".'),
  description: z.string().describe('Who the character is: background, want, flaw.'),
  appearance: z
    .string()
    .describe('How the character looks, precise enough to generate images from.'),
  voice: z.string().describe('How the character sounds and speaks.'),
});
export type Character = z.infer<typeof Character>;
