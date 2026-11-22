import type { Mode } from '@imp/agents';
import { LANGUAGES, type GuideTopic, type GuideTranslations, type Language } from '@imp/core';
import { workspaceGuidesDe } from './guide.de.js';

/** Imp's own pages in each language other than English. */
const workspaceTranslations: GuideTranslations = { de: workspaceGuidesDe };

/** Every translated page, Imp's own and the modes' stages', by language. */
export function guideTranslations(modes: readonly Mode[]): GuideTranslations {
  const result: Partial<Record<Language, GuideTopic[]>> = {};
  for (const { id } of LANGUAGES) {
    if (id === 'en') continue;
    result[id] = [
      ...(workspaceTranslations[id] ?? []),
      ...modes.flatMap((mode) => mode.guideTranslations?.[id] ?? []),
    ];
  }
  return result;
}

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

The name stands for **Imp Makes Pictures**, a name that contains itself, in the spirit of GNU. On the Projects screen the imp tries on other meanings, one per visit (Imp Movie Production, Intelligent Movie Production, Infinite Montage Pipeline, Impossible Motion Pictures and more); press the line above the heading to see the next one.

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

Tell the **coordinator** (the panel on the right) your story in one sentence, for example "a lighthouse keeper finds a message in a bottle addressed to her". It plans the work, hires the crew it needs and walks you through each stage. It asks before anything costs money.

## Your first film, step by step

While tips are on, a slim bar above each stage shows the six steps to a first film: say what the film is, write a scene, cast a character, plan the shots, make one clip, and cut it together. Steps tick themselves off from what the project holds. Open the bar to see them all; **Go to** takes you to the stage, and **Ask the coordinator** puts the request in its message box for you to send. The × hides the bar for good.

## Learn from the sample film

On the **Projects** screen, **Open the sample film** makes a copy of "The Last Light", a three-scene short written down to every shot, line and sound. Nothing in it is generated yet, so opening it is free. Walk through the stages to see what a finished plan looks like, then make one shot's picture or clip to see the next step; the price is on the button. The copy is yours to change or delete. (Agents open it with project.create and the template movie.sample-last-light.)`,
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

Under **More roles** on the **Crew** page are extras that are not part of the usual crew until you add them:

- **Critic**: watches the film and leaves notes on the timeline.

Define roles of your own on the **Crew** page, such as an advisor or a second critic, and save a whole crew to the library to load it into another project.

## Chats belong to projects

Each project has its own chat with the coordinator and with every crew member. When you open another project, its chats come up, and the agents only remember what was said in that project. The crew itself is the same in every project, and the coordinator can still look after things across projects, such as the library, saved crews and your other projects. On the start screen, with no project open, agents talk in a chat of their own.

**Clear chat** at the top of a chat forgets it for the current project, after asking; other projects keep theirs. What the agent made stays.

## Everything you can do, they can do

Every button in Imp runs a command, and agents use the same commands. Whatever you can do by hand, an agent can do for you, and whatever an agent did, you can change by hand.

## Approvals and budgets

Agents ask before they delete something, and before they spend beyond the budget without approval: an approval card appears in their panel. Until a project's budget is used up, paid steps run without asking, so that work you hand over, like a whole film from one prompt, does not stop for every cent. Set the budget in the Spending panel (the coins in the top bar), which also shows how much is left: $1 per project at first, with an optional most per step. Set it to 0 to approve every paid step yourself. Each agent also has a budget per run, and stops when it is reached.`,
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
- Agents ask for approval once a project's budget without approval is used up ($1 at first, set in the Spending panel); the approval card shows the price too. An agent stops at its budget per run.
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
- The **Crews** tab keeps saved crews to load into any project. A saved crew keeps every agent with its model, budget and web search, and copies of the custom roles they hold, so it loads even after a role was deleted. Load it to replace the crew or to add to it.
- The **Mixes** tab keeps model mixes: which model the agents think with and which makes pictures, voices, sound effects, music, clips and transcripts. Apply one to set them all at once; the Models chip on every stage does the same.

Crews and mixes belong to the whole workspace, not to one project. Agents use the same library: ask the coordinator to "save this crew" or "save these models as a mix" and it does it.`,
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
- **Save all / Load all** keeps everything in Imp in one file; see the page on saving all.

The project switcher at the top of the screen changes the open project from anywhere.`,
  },
  {
    id: 'save-all',
    area: 'workspace',
    title: 'Save all and Load all',
    summary: 'Keep everything in Imp in one .zip file, and bring it all back.',
    body: `**Save all** puts everything in Imp into one .zip file: every project with its pictures, voices, clips and rendered films, the library, saved crews, model mixes, custom roles, conversations with agents, settings, help choices and the look of the screen. Your **OpenRouter key is never in it**, so the file is safe to keep on a drive or in a cloud folder.

**Load all** replaces everything in Imp with what such a file holds. Use it to restore a backup, or to move all your work between browsers, computers and the local server at once.

## Where they are

On the **Projects** screen under **Save all / Load all**, and under **Settings**. The coordinator can do both too: ask it to save everything, and Imp offers you the file to keep.

## Saving

In Chrome and Edge on a computer, Imp asks where to save the file. Other browsers, and tablets, save it to the downloads. Large workspaces take a while: the file is written piece by piece, so even many gigabytes fit.

## Loading

- Imp shows the file and asks before it changes anything. Choose **Save all first** if you may want your current work back.
- The whole file is checked before anything changes. A damaged file changes nothing.
- Projects, library items and settings that are in Imp now but not in the file are gone afterwards.
- Your OpenRouter key stays as it is.
- The page reloads when it is done.

A single project's file (.imp.zip) is not a full backup: bring it in with **Import** on the Projects screen.`,
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

Work done in the browser does not move over by itself: export the project and import it there, or move everything at once with **Save all** and **Load all**.

## Your OpenRouter key

In the browser, the key is kept encrypted in the browser's storage, with an encryption key the browser holds and never lets any script read. On your computer, Imp keeps the key in its own file beside your projects, readable only by your user account, and the browser never holds it. Either way no command or agent can read it, and it is sent only to OpenRouter.

## ffmpeg

On your computer Imp uses **ffmpeg**, free software, to render films in the background, to hear the sound inside video clips and to show agents stills of a cut. If ffmpeg is not installed, Imp offers to download it (about 20 to 30 MB) on the Edit stage's export bar and under **Settings**, checks the download and uses it at once. Until then, films are recorded in the browser in real time.

## The download is not signed

Imp's download is not signed with a paid developer certificate. Started with \`node imp.mjs\` from a terminal, nothing asks. If your system does warn about a file from the download:

- **macOS**: "cannot be opened because the developer cannot be verified". Open **System Settings**, then **Privacy & Security**, scroll down and press **Open Anyway** next to the file's name. Or right-click (Control-click) the file in Finder, choose **Open**, and confirm. You do this once.
- **Windows**: "Windows protected your PC" (SmartScreen). Press **More info**, then **Run anyway**. Or right-click the zip before unzipping, choose **Properties** and tick **Unblock**.
- **Linux**: nothing to confirm. If a file will not start, make it runnable with \`chmod +x\`.`,
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
    summary: 'Tips, Ask Imp, this guide, and reporting a problem.',
    body: `## Tips

The first time you open a stage, a short tip says what it is for. Close one with **Got it**. If you know your way around, **Turn off all tips** removes every tip at once; the help panel and Ask Imp stay. Turn them back on in **Settings** or in this panel.

## Ask Imp

The **Help** button opens **Ask Imp**. Ask anything in plain words, such as "how do I make a dissolve?" or "what will this scene cost?". Imp answers from this guide and can see your project. Ask it to do the step and it does it for you, with the same buttons you have; it asks before spending money or deleting anything. Imp runs on the coordinator's model and counts toward your spending like any agent.

The coordinator can answer questions about Imp too.

## Report a problem

Something broken or confusing? In the Help panel, open **Report a problem**, say what happened and press **Write the report**. Imp adds its version, where it runs, your screen size and the last few commands with their errors. Your key, prompts and story never go in. **Open on GitHub** shows the report as a new issue, filled in; read it and press Submit (you need a free GitHub account). Or **Copy the report** and send it another way. Ask Imp can write the report for you too.

## The guide on the web

This guide is also a website, beside the app: **The guide on the web** at the bottom of the Help panel opens it.`,
  },
];
