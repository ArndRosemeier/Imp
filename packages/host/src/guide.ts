import type { GuideTopic } from '@imp/core';

/**
 * The guide's pages about Imp as a whole. The pages about each stage come
 * from the working modes, beside the stages themselves.
 */
export const workspaceGuides: readonly GuideTopic[] = [
  {
    id: 'getting-started',
    area: 'workspace',
    title: 'Getting started',
    summary: 'What Imp is, how a film is made in it, and the fastest way to a first film.',
    body: `Imp makes films of any length from AI-generated pictures, voices, sounds and video clips, and keeps them coherent from the first scene to the last. You can do every step yourself, hand any step to an AI agent, or mix both.

## How a film is made

The stages on the left follow the way films are made. Visit them in any order:

1. **Development**: the idea, the premise and the tone.
2. **Script**: the scenes and their dialogue.
3. **Casting**: characters with portraits and voices.
4. **Design**: the locations and objects, so every shot of a place matches.
5. **Shots**: each scene split into shots, each shot made into a video clip.
6. **Sound**: effects and music.
7. **Edit**: everything joined into the film, then exported.
8. **Audio**: a full audio editor for fine work on sound.

## The fastest way to a first film

Tell the **coordinator** (the panel on the right) your story in one sentence, for example "a lighthouse keeper finds a message in a bottle addressed to her". It plans the work, hires the crew it needs and walks you through each stage. It asks before anything costs money.`,
  },
  {
    id: 'crew-and-agents',
    area: 'workspace',
    title: 'The crew: working with AI agents',
    summary: 'The coordinator, the roles you can hire, and how to give them work.',
    body: `Imp's AI agents are called the **crew**. Each is hired for a role and runs on a model of your choice.

## The coordinator

The coordinator is the agent in the panel on the right. Talk to it like a producer: say what you want, and it plans, hires and hands out the work. It can change settings and set things up for you.

## Roles

- **Screenwriter**: development and scenes.
- **Casting Director**: characters, portraits and voices.
- **Production Designer**: locations and objects.
- **Clip Designer**: shots and video clips.
- **Sound Designer**: sound effects and music.
- **Film Editor**: cuts scenes; its changes arrive as proposals you keep or reject.
- **Sound Editor**: mixes and cleans sound.
- **Critic**: watches the film and leaves notes on the timeline.

Define roles of your own on the **Crew** page, such as an advisor or a second critic, and save a whole crew to the library to load it into another project.

## Everything you can do, they can do

Every button in Imp runs a command, and agents use the same commands. Whatever you can do by hand, an agent can do for you, and whatever an agent did, you can change by hand.

## Approvals and budgets

Agents ask before they spend money or delete something: an approval card appears in their panel. Each agent has a budget per run, and stops when it is reached.`,
  },
  {
    id: 'costs',
    area: 'workspace',
    title: 'What things cost',
    summary:
      'Where money is spent, prices before you press, the running total, and keeping costs low.',
    body: `Imp is free. Generation is paid to **OpenRouter** with your own key, at OpenRouter's prices. Nothing is charged by Imp itself.

## Rough prices with the starter models

- An agent's answer: a fraction of a cent to a few cents.
- A portrait or key frame: about 1 cent.
- A voice sample or a line of dialogue: 1 to 2 cents.
- A sound effect: 1 to 2 cents. A 30 second piece of music: about 4 cents.
- A 4 second video clip: about 15 to 40 cents. Clips are most of the cost of a film.

## Before and after

- Every button that spends money shows the expected price on it, for example **Generate clip ≈ $0.20**. A video price comes from the model's own price list; other prices come from what the same model cost you before. A dashed price is a rough typical one, used until the model has been tried once.
- Agents ask for approval before they spend; the approval card shows the price too. An agent stops at its budget per run.
- The **total** in the top bar shows what this project has cost. Open it for today, all projects, a breakdown by kind and the latest calls. Asking an agent "what has this cost so far?" works too.

## Keeping costs low

- Make a key frame (a still, about 1 cent) and check it before making the clip.
- Use short clips; the edit can slow them down or hold the last frame.
- Use the **Starter** model mix while you learn and switch to **Balanced** or **Best** for the final film, from the Models chip on any stage.`,
  },
  {
    id: 'library',
    area: 'workspace',
    title: 'The library',
    summary: 'Every picture, sound, clip and text of the project in one place.',
    body: `The **Library** button in the top bar opens the project's library beside any stage. It holds every portrait, key frame, location picture, clip, line of dialogue, sound, piece of music, audio document, scene and note, whatever made it.

## What you can do

- Search by name, words, tags or notes; filter by kind; star what matters.
- **Import** your own pictures, sounds, videos and texts, or drop files onto the library.
- Drag an asset where it belongs: a picture onto a character to make it their portrait, a sound onto the Edit audio lane, a video onto a shot. On a tablet, hold it a moment first, or tap it and choose **Use in**.
- Copy assets into another project.
- The **Crews** tab keeps saved crews to load into any project.

Agents use the same library.`,
  },
  {
    id: 'projects',
    area: 'workspace',
    title: 'Projects',
    summary: 'Start, duplicate, export and import projects, and copy between them.',
    body: `The **Projects** page lists your films.

- **New project** starts empty or from a template: a short film, a music video, a trailer or a two-hander.
- **Duplicate** a project to try a different direction without losing the original.
- **Export** a project as one file to keep it safe or move it to another computer, and **Import** it back.
- **Copy** characters, scenes, locations and other parts from one project into another.

The project switcher at the top of the screen changes the open project from anywhere.`,
  },
  {
    id: 'where-imp-runs',
    area: 'workspace',
    title: 'Browser or your own computer',
    summary: 'The difference between running Imp in the browser and on the local server.',
    body: `Imp runs in two ways, with the same features.

## In the browser

Nothing to install. Your projects are kept in the browser's own storage on this computer. Agents only work while the tab is open: closing it pauses a running agent, and you can ask it to continue later. Clear your browser data and the projects go with it, so export the ones that matter.

## On your computer

Download Imp from **Settings** and run it with Node.js 22 or newer: unzip it, run \`node imp.mjs\` in the folder and open the address it prints. Your work is then kept as files in a folder of yours, with room for large media, and agents keep working when the browser is closed.

Work done in the browser does not move over by itself: export the project and import it there.`,
  },
  {
    id: 'tablet-and-keys',
    area: 'workspace',
    title: 'Tablet, touch and keyboard',
    summary: 'Using Imp on a landscape tablet, and the keyboard shortcuts.',
    body: `Imp works on tablets held sideways (landscape) with touch. Phones are not supported.

## Touch

- Tap where a mouse would click. Hold an item a moment before dragging it.
- Pinch to zoom the film strip and the timeline.
- On a narrower screen the library and the crew panel take turns, so the stage keeps its room.

## Keyboard

- **Ctrl K**: run any command by name.
- **Ctrl Shift L**: show or hide the library.
- **Space**: play and pause on the Edit and Audio stages.
- **I** and **O**: mark the start and end of a stretch on the Edit stage.
- **M**: leave a marker at the playhead.
- **Comma** and **full stop**: step one frame back or on.
- **R**: record from the microphone in the audio editor.`,
  },
  {
    id: 'help-and-support',
    area: 'workspace',
    title: 'Help and support',
    summary: 'Tips, Ask Imp, and this guide.',
    body: `## Tips

The first time you open a stage, a short tip says what it is for. Close one with **Got it**. If you know your way around, **Turn off all tips** removes every tip at once; the help panel and Ask Imp stay. Turn them back on in **Settings** or in this panel.

## Ask Imp

The **Help** button opens **Ask Imp**. Ask anything in plain words, such as "how do I make a dissolve?" or "what will this scene cost?". Imp answers from this guide and can see your project. Ask it to do the step and it does it for you, with the same buttons you have; it asks before spending money or deleting anything. Imp runs on the coordinator's model and counts toward your spending like any agent.

The coordinator can answer questions about Imp too.`,
  },
];
