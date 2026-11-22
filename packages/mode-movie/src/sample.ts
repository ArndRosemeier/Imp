import type { JsonValue, ProjectTemplate } from '@imp/core';
import { Character, Scene, Shot, Sound, type Development } from './schema.js';

/**
 * The sample film: a short story written all the way down to its shots, with
 * nothing generated yet. A newcomer opens it to see what each stage holds when
 * it is filled in, and makes a picture or a clip from any shot to see the next
 * step, at the price shown on the button. Nothing in it costs money until then.
 */

interface ShotDraft {
  readonly description: string;
  readonly cast: readonly ('mara' | 'tomas')[];
  readonly performance: string;
  readonly speaker?: 'mara' | 'tomas';
  readonly line?: string;
  readonly delivery?: string;
}

interface SceneDraft {
  readonly heading: string;
  readonly summary: string;
  readonly body: string;
  readonly shots: readonly ShotDraft[];
  readonly sounds: readonly (readonly [
    kind: 'effect' | 'music',
    name: string,
    description: string,
  ])[];
}

const DEVELOPMENT: Development = {
  logline:
    'On the last night before her lighthouse goes automatic, an old keeper and the young engineer sent to replace her must keep a fishing boat off the rocks when the new lamp fails in a storm.',
  premise:
    'Mara has kept the light at Skerry Point for forty years. Tomas has come to fit the automatic lamp that ends her job. Neither wants the other there. When the storm takes the new lamp, only the old way of doing things can save the boat, and only together.',
  tone: 'Quiet, weathered drama turning to tension. Cold blue night against the warm amber of the lamp. Handheld close-ups inside, wide, still shots of the sea outside. Few words; the storm says the rest.',
  treatment:
    'Dusk. Mara climbs the stairs of the lighthouse one last time and lights the great lamp by hand, as she has every night for forty years. A van comes up the cliff road: Tomas, young and polite, with crates of equipment. He has come to fit the automatic lamp tonight; she will leave in the morning.\n\nThey work around each other in the lamp room as the wind rises. He is kind and she is curt. He switches on the new lamp and the old one goes dark for the first time in a century.\n\nPast midnight the storm is at its worst. A fishing boat shows its lights beyond the rocks. Then the new lamp flickers and dies: water in the housing. Tomas cannot fix it in time. Mara pulls the cover off the old lamp, and the two of them crank it and light it together, Tomas holding the shutter while she trims the wick. The beam sweeps out, and the boat turns away from the rocks.\n\nDawn. The sea is calm. Mara hands Tomas the logbook, the last page still empty, and walks down the cliff road without looking back. Tomas writes the first line.',
};

const CHARACTERS = {
  mara: {
    name: 'Mara',
    part: 'protagonist',
    description:
      'Keeper of the Skerry Point light for forty years, widowed, alone by choice. She wants one more night of being needed. Her flaw: she would rather be right than helped.',
    appearance:
      'A woman of about seventy, tall and lean, weathered face, deep lines around grey eyes, white hair cut short. A heavy navy wool sweater with frayed cuffs, oilskin trousers, rubber boots. Strong, scarred hands.',
    voice: 'Low and dry, a coastal accent, few words. Never raises her voice except to the sea.',
  },
  tomas: {
    name: 'Tomas',
    part: 'second lead',
    description:
      'An engineer in his late twenties, sent from the mainland to automate the light. He wants to do the job well and be liked for it, and believes machines are kinder than the old way.',
    appearance:
      'A man of about twenty-eight, slight build, dark curly hair under a beanie, light stubble, wire-rimmed glasses. A new orange high-visibility jacket over a grey hoodie, a tool belt.',
    voice: 'Quick and warm, a city accent, talks to fill silences, apologises too often.',
  },
} as const;

const SCENES: readonly SceneDraft[] = [
  {
    heading: 'EXT./INT. SKERRY POINT LIGHTHOUSE - DUSK',
    summary:
      'Mara lights the lamp by hand for the last time. Tomas arrives with the automatic lamp that will replace her.',
    body: 'A white lighthouse on black rocks. The sea is grey and restless.\n\nINT. LAMP ROOM\n\nMARA climbs the last iron steps, strikes a match and lights the great lamp. The lens begins to turn. She watches it as if it might be the last time. It is.\n\nHeadlights on the cliff road below.\n\nEXT. LIGHTHOUSE DOOR\n\nTOMAS unloads crates from a van. Mara watches from the doorway.\n\nTOMAS\nYou must be Mara. I am so sorry about the hour.\n\nMARA\nThe light does not care what hour it is.',
    shots: [
      {
        description:
          'Wide establishing shot at dusk: a white lighthouse on black rocks above a restless grey sea, the first lamp glow at the top. Slow push in.',
        cast: [],
        performance: 'Waves break white against the rocks; gulls wheel past the tower.',
      },
      {
        description:
          'Close-up in the lamp room, warm amber light: an old woman strikes a match and lights the wick of a great brass lamp inside a glass lens.',
        cast: ['mara'],
        performance:
          'Mara cups the flame with practised hands, lights the wick, then steps back and watches the lens begin to turn, her face lit amber.',
      },
      {
        description:
          'Medium shot outside the lighthouse door, cold blue dusk: a young man unloads crates from a white van; the old woman watches from the doorway.',
        cast: ['tomas', 'mara'],
        performance:
          'Tomas lifts a crate, sees Mara, sets it down and hurries over with an outstretched hand. Mara does not take it.',
        speaker: 'tomas',
        line: 'You must be Mara. I am so sorry about the hour.',
        delivery: 'Bright and nervous, a little out of breath, over the wind.',
      },
      {
        description:
          'Close-up of the old woman in the doorway, the lamp beam sweeping the sky behind her.',
        cast: ['mara'],
        performance: 'Mara looks past him at the crates, then back at him, unmoved.',
        speaker: 'mara',
        line: 'The light does not care what hour it is.',
        delivery: 'Flat and dry, quiet, not unkind.',
      },
    ],
    sounds: [
      [
        'effect',
        'Sea at dusk',
        'Waves breaking on rocks below a cliff, steady wind, distant gulls.',
      ],
      [
        'music',
        "Mara's theme",
        'A slow solo cello over a soft held string chord, 60 bpm, melancholy and warm, rising a little at the end.',
      ],
    ],
  },
  {
    heading: 'INT. LAMP ROOM - NIGHT',
    summary:
      'The storm rises. The new lamp goes on and the old one goes dark. A fishing boat appears off the rocks, and the new lamp fails.',
    body: 'Rain hammers the glass. Tomas fits the last panel of the automatic lamp. Mara pretends to read the logbook.\n\nTOMAS\nIt does everything by itself. You will not have to climb these stairs again.\n\nHe throws the switch. A hard white beam. The old lamp goes dark.\n\nLater. Boat lights beyond the rocks. The white beam flickers, buzzes, dies. Darkness.\n\nTOMAS\nThere is water in the housing. I need an hour.\n\nMARA\nThey have five minutes.',
    shots: [
      {
        description:
          'Medium shot in the lamp room at night, rain streaming down the glass: the young engineer fits a panel on a modern white lamp unit beside the old brass lamp.',
        cast: ['tomas', 'mara'],
        performance:
          'Tomas tightens a bolt and taps the unit proudly; behind him Mara sits with an old logbook, not reading it.',
        speaker: 'tomas',
        line: 'It does everything by itself. You will not have to climb these stairs again.',
        delivery: 'Proud, trying to be kind, missing the point.',
      },
      {
        description:
          'Close-up of a hand throwing a switch; hard white light floods the room and the warm amber glow of the old lamp goes out.',
        cast: ['tomas'],
        performance:
          'Tomas throws the switch firmly; the colour of the whole room changes from amber to white.',
      },
      {
        description:
          'Wide shot through the rain-streaked lamp room glass: a small fishing boat with two lights pitching in huge waves beyond black rocks.',
        cast: [],
        performance:
          'The boat climbs a wave and drops out of sight, then its lights reappear, closer to the rocks.',
      },
      {
        description:
          'Medium shot: the modern lamp flickers and dies, plunging the lamp room into darkness lit only by lightning. The young engineer opens its housing with a torch.',
        cast: ['tomas', 'mara'],
        performance:
          'Tomas pries the housing open and water pours out; he looks up at Mara, panicking. Mara is already on her feet.',
        speaker: 'tomas',
        line: 'There is water in the housing. I need an hour!',
        delivery: 'Panicked, shouting over the storm.',
      },
      {
        description:
          'Close-up of the old woman in the dark, lit by a flash of lightning, looking at the old brass lamp.',
        cast: ['mara'],
        performance: 'Mara grips the rail, eyes fixed on the boat, then turns to the old lamp.',
        speaker: 'mara',
        line: 'They have five minutes.',
        delivery: 'Quiet, absolutely certain, a decision made.',
      },
    ],
    sounds: [
      [
        'effect',
        'Storm on the glass',
        'Heavy rain lashing a glass dome, wind howling through an iron frame, rolling thunder.',
      ],
      ['effect', 'Lamp dying', 'An electric buzz that stutters and cuts out with a sharp click.'],
    ],
  },
  {
    heading: 'INT. LAMP ROOM - NIGHT / EXT. CLIFF ROAD - DAWN',
    summary:
      'Together they light the old lamp by hand and the boat turns away from the rocks. At dawn Mara hands Tomas the logbook and leaves.',
    body: 'Mara rips the canvas off the old lamp. She hands Tomas the crank.\n\nMARA\nTurn. Do not stop.\n\nHe turns. She trims the wick and strikes a match. Amber light. The beam sweeps out into the storm. Far out, the boat lights swing away from the rocks.\n\nEXT. CLIFF ROAD - DAWN\n\nCalm sea. Mara hands Tomas the logbook, its last page empty, and walks down the road. He opens it and writes.',
    shots: [
      {
        description:
          'Handheld medium shot in the dark lamp room: the old woman rips a canvas cover off the brass lamp and pushes a heavy iron crank into the young engineer’s hands.',
        cast: ['mara', 'tomas'],
        performance:
          'Mara yanks the canvas away in one pull and shoves the crank at Tomas; he fumbles it, then grips it with both hands.',
        speaker: 'mara',
        line: 'Turn. Do not stop.',
        delivery: 'Commanding, shouting over the storm, no fear in it.',
      },
      {
        description:
          'Close-up, two shots in one frame: the young engineer cranking with all his weight while the old woman strikes a match and lights the wick. Warm amber floods their faces.',
        cast: ['tomas', 'mara'],
        performance:
          'Tomas cranks hard, gritting his teeth; Mara lights the wick in one steady movement. The light blooms over both their faces and they look at each other.',
      },
      {
        description:
          'Wide night shot from the sea: the lighthouse beam sweeps across the storm and catches the fishing boat, which turns hard away from the black rocks.',
        cast: [],
        performance:
          'The beam passes over the boat twice; on the second pass it is already turning, spray flying from its bow.',
      },
      {
        description:
          'Wide shot at dawn on a cliff road above a calm silver sea, the lighthouse behind: the old woman hands the young engineer a worn leather logbook.',
        cast: ['mara', 'tomas'],
        performance:
          'Mara holds the logbook out; Tomas takes it with both hands. She nods once and walks away down the road without looking back.',
      },
      {
        description:
          'Close-up of an open logbook, the last page empty, a hand beginning to write in pencil. Soft dawn light.',
        cast: ['tomas'],
        performance: 'Tomas hesitates, then writes the date and the words "Light kept."',
      },
    ],
    sounds: [
      [
        'effect',
        'The old crank',
        'A heavy iron crank turning a clockwork drum, ratcheting, steady rhythm.',
      ],
      [
        'music',
        'Dawn',
        "Mara's cello theme returns with a gentle piano, 60 bpm, hopeful and calm, fading out slowly.",
      ],
    ],
  },
];

function build(newId: () => string): { key: string; value: JsonValue }[] {
  const records: { key: string; value: JsonValue }[] = [];
  const now = new Date().toISOString();
  records.push({ key: 'movie/development', value: DEVELOPMENT });

  const ids: Record<keyof typeof CHARACTERS, string> = { mara: newId(), tomas: newId() };
  for (const [handle, draft] of Object.entries(CHARACTERS) as [
    keyof typeof CHARACTERS,
    (typeof CHARACTERS)[keyof typeof CHARACTERS],
  ][]) {
    const value = Character.parse({ id: ids[handle], ...draft });
    records.push({ key: `movie/characters/${value.id}`, value });
  }

  SCENES.forEach((draft, index) => {
    const scene = Scene.parse({
      id: newId(),
      position: index + 1,
      heading: draft.heading,
      summary: draft.summary,
      body: draft.body,
    });
    records.push({ key: `movie/scenes/${scene.id}`, value: scene });
    draft.shots.forEach((shotDraft, shotIndex) => {
      const shot = Shot.parse({
        id: newId(),
        sceneId: scene.id,
        position: shotIndex + 1,
        description: shotDraft.description,
        characterIds: shotDraft.cast.map((handle) => ids[handle]),
        performance: shotDraft.performance,
        speakerId: shotDraft.speaker === undefined ? null : ids[shotDraft.speaker],
        line: shotDraft.line ?? '',
        delivery: shotDraft.delivery ?? '',
      });
      records.push({ key: `movie/shots/${scene.id}/${shot.id}`, value: shot });
    });
    for (const [kind, name, description] of draft.sounds) {
      const sound = Sound.parse({
        id: newId(),
        sceneId: scene.id,
        kind,
        name,
        description,
        createdAt: now,
      });
      records.push({ key: `movie/sounds/${scene.id}/${sound.id}`, value: sound });
    }
  });
  return records;
}

export const sampleFilm: ProjectTemplate = {
  id: 'movie.sample-last-light',
  name: 'The Last Light',
  summary:
    'A finished example: a three-scene short about a lighthouse keeper, written down to every shot, line and sound. Nothing is generated yet, so it costs nothing to open.',
  sample: true,
  build,
};
