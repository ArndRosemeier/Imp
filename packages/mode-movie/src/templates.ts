import type { JsonValue, ProjectTemplate } from '@imp/core';
import type { Character, Development, Scene } from './schema.js';

/** Keys relative to the project, as templates give them. */
const DEVELOPMENT = 'movie/development';
const scene = (id: string): string => `movie/scenes/${id}`;
const character = (id: string): string => `movie/characters/${id}`;

interface Draft {
  readonly development?: Partial<Development>;
  /** Heading and summary of each scene, in order. The summary says what the scene must do. */
  readonly scenes: readonly (readonly [heading: string, summary: string])[];
  readonly characters?: readonly (readonly [name: string, part: string, description: string])[];
}

function build(draft: Draft) {
  return (newId: () => string): { key: string; value: JsonValue }[] => {
    const records: { key: string; value: JsonValue }[] = [];
    const development: Development = {
      logline: '',
      premise: '',
      tone: '',
      treatment: '',
      ...draft.development,
    };
    records.push({ key: DEVELOPMENT, value: development });
    draft.scenes.forEach(([heading, summary], index) => {
      const value: Scene = { id: newId(), position: index + 1, heading, summary, body: '' };
      records.push({ key: scene(value.id), value });
    });
    for (const [name, part, description] of draft.characters ?? []) {
      const value: Character = {
        id: newId(),
        name,
        part,
        description,
        appearance: '',
        voice: '',
        images: [],
        portraitId: null,
        voiceSample: null,
        voiceOnly: false,
        ownLane: false,
      };
      records.push({ key: character(value.id), value });
    }
    return records;
  };
}

/** The starting points the movie mode ships with. Each is a structure to fill, not a story. */
export const movieTemplates: readonly ProjectTemplate[] = [
  {
    id: 'movie.short-film',
    name: 'Short film',
    summary:
      'Five scenes in three acts, from the opening image to the last one. About 3 to 8 minutes.',
    build: build({
      development: {
        treatment:
          'Act one: who the hero is and what is missing. Act two: they go after it and it costs them. Act three: they win or lose it, and are changed either way.',
      },
      scenes: [
        [
          'OPENING IMAGE',
          'The hero in their ordinary world. One image that shows what is missing.',
        ],
        ['INCITING INCIDENT', 'Something happens that the hero cannot ignore.'],
        [
          'TURNING POINT',
          'Halfway: the hero commits, or learns the truth, and there is no way back.',
        ],
        ['CLIMAX', 'The hardest moment. The hero chooses, and the choice shows who they are.'],
        [
          'FINAL IMAGE',
          'The ordinary world again, and how it has changed. Mirror the opening image.',
        ],
      ],
      characters: [
        [
          'The hero',
          'protagonist',
          'Who they are, what they want, and the flaw that stands in the way.',
        ],
      ],
    }),
  },
  {
    id: 'movie.music-video',
    name: 'Music video',
    summary:
      'Sections that follow a song: intro, verses, choruses, bridge, outro. Cut to the music.',
    build: build({
      development: {
        tone: 'Name the song, its tempo and mood, and the look: one palette and one camera language throughout.',
      },
      scenes: [
        ['INTRO', 'Set the world and the look before the voice comes in.'],
        ['VERSE ONE', 'The story or the performer, close; the first idea of the video.'],
        ['CHORUS', 'Open up: the biggest image, repeated each chorus with a change.'],
        ['VERSE TWO', 'The idea develops; something has moved on since verse one.'],
        ['BRIDGE', 'A break in the pattern: a new place, a stillness, or a reveal.'],
        ['FINAL CHORUS', 'Everything at once, at its largest.'],
        ['OUTRO', 'Let it settle. The last image stays after the music.'],
      ],
    }),
  },
  {
    id: 'movie.trailer',
    name: 'Trailer',
    summary: 'A 60 to 90 second trailer: world, hook, escalation, montage, title and a last beat.',
    build: build({
      scenes: [
        ['THE WORLD', 'Where and when, in two or three quiet shots.'],
        ['THE HOOK', 'The event that starts the story, and the question it asks.'],
        ['ESCALATION', 'Stakes rise; each shot shorter and louder than the last.'],
        ['MONTAGE', 'The best images, fast, on the music. No full sentences.'],
        ['TITLE CARD', 'The title, alone.'],
        ['THE BUTTON', 'One last surprising or funny moment after the title.'],
      ],
    }),
  },
  {
    id: 'movie.two-hander',
    name: 'Two-hander',
    summary: 'One place, two characters, one conversation that changes them both.',
    build: build({
      development: {
        premise: 'Two people who want different things from the same conversation.',
      },
      scenes: [
        [
          'INT. ONE ROOM - NIGHT',
          'They meet. Each wants something from the other and hides it. By the end one of them has it.',
        ],
      ],
      characters: [
        ['The first', 'lead', 'What they want from the conversation, and what they hide.'],
        [
          'The second',
          'lead',
          'What they want instead, and what they know that the first does not.',
        ],
      ],
    }),
  },
];
