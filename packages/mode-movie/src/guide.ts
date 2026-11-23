import type { GuideTopic } from '@imp/core';

/**
 * The guide's pages about the movie stages, each with the tip shown the first
 * time the stage opens. Written for the person making the film: what the stage
 * is for, what to do first, and who on the crew can do it for them.
 */

export const developmentGuide: GuideTopic = {
  id: 'stage-development',
  area: 'development',
  title: 'Development',
  summary: 'The idea of the film before there is a script: logline, premise, tone, treatment.',
  hint: {
    title: 'Start with the idea',
    body: 'Write a logline and the story in a few paragraphs, or tell the coordinator your idea in one sentence and let the Screenwriter draft it. Everything later builds on this page.',
  },
  body: `Development holds what the film is before there is a script: the **logline** (the film in a sentence or two), the **premise** (the situation, the main character and what is at stake), the **tone** (genre, mood and visual style) and the **treatment** (the story in prose, beginning to end).

## What to do here

1. Write the logline: who wants what, and what stands in the way.
2. Write the premise and then the treatment.
3. Put the visual style into the tone in words (for example "grainy 16mm, cold blues, handheld"). Pictures of the world are drawn in it, so the film looks like one film.

## Let the crew do it

Tell the coordinator the story in a sentence. It hires a **Screenwriter**, who writes the development. You can change every word afterwards.

## Checkpoints

The crew stops for you at three points, so that nothing expensive is made before you have looked: the **treatment** (here), the **storyboard** of each scene (in Shots) and the **first cut** of each scene (in Edit). Press **Sign off** when it is right; casting, design and the scenes wait for the treatment, the clips of a scene for its storyboard. **How much the crew does on its own** sets where it stops: at each checkpoint, only at the storyboard, or nowhere. Spending always keeps to the budget.

## Tips

- Short films work best with one main character and one clear turn.
- A clear visual style is worth a minute: it is the cheapest way to keep a long film coherent.`,
};

export const scriptGuide: GuideTopic = {
  id: 'stage-script',
  area: 'script',
  title: 'Script',
  summary: 'Scenes and the screenplay: what happens, where, who speaks.',
  hint: {
    title: 'Break the story into scenes',
    body: 'Each scene gets a place, a time of day, what happens and the lines. Ask the Screenwriter to draft them from Development, then rewrite whatever you like.',
  },
  body: `The Script stage holds the film's **scenes** in order. Each scene has a heading (place and time of day), a summary of what happens, the screenplay with action and dialogue, and optionally the location from Design where it happens. The header shows how long the script runs: a page is about a minute of film.

## Writing a scene

Scenes are written in **Fountain**, the plain-text screenplay format that screenwriting apps use, and shown as a proper screenplay page. Switch between **Page** and **Write** above the scene.

- A character's name in capitals on its own line speaks the lines under it. Add (V.O.) or (O.S.) when they are not seen.
- How a line is said goes in brackets on its own line: (whispering).
- Transitions are in capitals and end in TO:, like CUT TO:.
- *Italic* and **bold** mark emphasis.
- In Write, **Tab** turns the line into the next part (action, character, direction, dialogue, transition) and Shift+Tab goes back. The buttons above the text do the same on a tablet, and the cast's names are one tap away.

## Script and shots

On the page, each line of dialogue shows the shot that speaks it, or "no shot". In Shots, **From the script** fills a shot's line, speaker and delivery from the script. Lines spoken in shots that are not in the script are listed under the scene, ready to add.

## Files

**Import** brings in a Fountain or Final Draft (.fdx) script as new scenes. **Download** writes the script as a PDF in the standard screenplay layout, as Fountain or as Final Draft.

## What to do here

1. Add scenes yourself with the plus button, or ask the Screenwriter to break the synopsis into scenes.
2. Open a scene from the tabs to write or rewrite it, and link it to its location.
3. Write lines the way they should be performed. "Get away from the rail!" comes out louder than "Get away from the rail."

## How scenes are used later

- Casting finds the characters who speak.
- Shots splits each scene into shots, and the clips speak each line with matching lips.
- Edit lays each scene out as its own timeline and joins them into the film.

## Let the crew do it

The **Screenwriter** writes and rewrites scenes. Ask for a change in plain words: "make scene 3 shorter and give Mara the last line".`,
};

export const castingGuide: GuideTopic = {
  id: 'stage-casting',
  area: 'casting',
  title: 'Casting',
  summary: 'Characters with descriptions, portraits and voices.',
  hint: {
    title: 'Give every character a face and a voice',
    body: 'Describe each character, then make a portrait and a voice sample. Shots reuse the portrait so the same face appears in every clip. Each portrait or voice costs a cent or two.',
  },
  body: `Casting holds the film's **characters**: a description, portraits and a voice.

## What to do here

1. Add a character, or let the **Casting Director** find them in the script.
2. Write how they look: age, build, face, clothes. Be specific; the portrait follows it.
3. Make a **portrait**. Make a few and pick the one you like; the chosen portrait guides every clip they appear in.
4. Make a **voice**: describe how they speak and try a sample line with a direction such as "calm" or "panicked".

## Costs

A portrait costs about a cent with a cheap image model, a voice sample a little more. The price is on the button before you press it.

## Tips

- Drop any picture from the library onto a character to use it as their portrait.
- Keep descriptions stable once clips exist, so later clips still match earlier ones.`,
};

export const designGuide: GuideTopic = {
  id: 'stage-design',
  area: 'design',
  title: 'Design',
  summary: 'Locations and objects, drawn from every side the camera sees them.',
  hint: {
    title: 'Build the world once, use it everywhere',
    body: 'Add the places and important objects of the film. Each gets pictures from the angles the camera needs, and states such as "night" or "after the storm", so every shot of it matches.',
  },
  body: `Design holds the **locations** and **objects** of the film. Each has views (the sides the camera sees) and states (night, rain, wrecked), drawn in the film's visual style.

## What to do here

1. Add a location such as "the lighthouse kitchen" and describe it.
2. Make its views: wide, reverse, details. These become reference pictures for shots set there.
3. Add states when a place changes during the film.
4. Do the same for objects that matter to the story, such as a letter or a car.

## Let the crew do it

The **Production Designer** reads the script, finds the places and objects, and draws them.

## Why it matters

Video models forget what a room looked like between clips. Giving each shot the same location pictures keeps a long film coherent.`,
};

export const shotsGuide: GuideTopic = {
  id: 'stage-shots',
  area: 'shots',
  title: 'Shots',
  summary: 'Each scene split into shots, each shot made into a video clip.',
  hint: {
    title: 'Plan shots, then make clips',
    body: 'Describe each shot (framing, action, who is in it), choose a key frame if you want the clip to start on a set picture, then make the clip. Clips are the most expensive part of a film: the price is on the button, and a key frame is a cheap check first.',
  },
  body: `Shots splits each scene into **shots** and turns each into a **video clip**.

## What to do here

1. Pick a scene from the tabs.
2. Add shots: framing (wide, close-up), what happens, who is in it, and how long it **holds in the cut**, with a word on why. Vary the lengths: a glance is over in a second or two, a moment that should land takes longer. The clip is made a little longer than that, so the edit can cut it at its best moment.
3. Optionally make a **key frame**, a still picture the clip starts on. It is cheap and lets you check the look before paying for video. An **end frame** says where the clip lands, for models that take one.
4. Say how each shot **comes after the one before**: a new angle or place; *carries on the same take*, where the clip starts on the last frame of the one before so the action flows on (it is made after that clip); or a *cut on action*, the same instant from a new angle, whose key frame is painted to match where the shot before ends. Add why the cut is there; the Film Editor reads it.
5. Give a speaking shot its **line** and delivery. The clip speaks it itself, so the lips match, along with the sounds of the scene.
6. Make the **clip**. It takes a minute or two. The portraits of the characters in the shot and the location pictures go with it. Clips always have sound; video models that make none are not offered.
7. For a narrator or a voice off screen, **record the dialogue** in that character's voice; it plays over the clip.

## Takes

Making a clip again never throws the old one away. Earlier clips stay as **takes** under the clip; tap one to watch it and use it again.

## Costs

A 4 second clip costs roughly 15 to 40 cents depending on the model and resolution. The price is on the button before every clip, and the total is in the top bar.

## Let the crew do it

The **Clip Designer** plans the shots of a scene and paints their key frames first: that is the **storyboard**. Look at the frames in order and press **Sign off** above the shots when the scene works; only then are its clips made, because frames cost cents and clips dollars.`,
};

export const soundGuide: GuideTopic = {
  id: 'stage-sound',
  area: 'sound',
  title: 'Sound',
  summary: 'Music and extra sound, where a scene needs more than its clips bring.',
  hint: {
    title: 'Clips bring their own sound',
    body: 'Describe a sound ("waves breaking on rocks at night") or a piece of music and Imp makes it. Sounds go into the scene and can be placed on the Edit timeline or opened in the audio editor.',
  },
  body: `Clips come with their own sound: voices, noises and the ambience of the place. Sound holds what a scene needs beyond that: **music**, a steady **ambience bed** where the clips' backgrounds jump at the cuts, or an **effect** no clip makes.

## What to do here

1. Pick a scene.
2. Describe a sound effect. Start with what makes the sound: "a heavy door slamming in an empty hall".
3. Describe music: mood, instruments, tempo, and "instrumental, no vocals" if that is what you want.
4. Listen, and make it again if it is not right.

## Using the sounds

- On the Edit stage, drag a sound onto the audio lane at the right moment.
- Open any sound in the **Audio** stage to trim it, change its loudness or add effects.

## Let the crew do it

The **Sound Designer** adds sound when you ask for it, or where a scene's first cut lacks it, once you have signed that cut off.`,
};

export const editGuide: GuideTopic = {
  id: 'stage-edit',
  area: 'edit',
  title: 'Edit',
  summary: 'Join clips, sound and text into the film, and export it.',
  hint: {
    title: 'Put the film together',
    body: 'The strip shows the whole film, one block per scene. Open a scene to cut its shots, place sound and add titles. Picture and sound are edited separately. Export the film from the menu when it is ready.',
  },
  body: `Edit is where clips become a film. Imp exists to make films of any length that hold together, and this is where that happens.

## The film and its scenes

- The **film strip** shows every scene as a block as long as the scene: green when all its pieces are ready, amber while some are missing.
- Open a scene to see its **timeline**: pictures on one lane, sound on its own lanes, text on another.
- Playback runs on from one scene into the next, so you can watch the film through.

## Cutting

- Trim a piece by dragging its edges; split it at the playhead; drag pieces to reorder them.
- **Trim to planned length** (the arrows pointing inward) makes a first cut: every shot is cut down to how long it is planned to hold, with a sliver off the start and the rest off the end. With a piece selected, only that one. Then move the edges to the best moment.
- Select a piece to see its inspector: takes, speed, freeze frame, punch-in, colour grade, and how it comes in (cut, dissolve, dip, wipe).
- **Transitions**: select the second of two pieces and choose under *Comes in with* how it arrives: cut, dissolve, dip to black or white, or wipe. **Length (s)** below the choice sets how long it takes (0.1 to 5 seconds). A dissolve or wipe lies over the piece before, so the scene gets that much shorter; a dip keeps its length.
- **J and L cuts** let the sound of one shot start early or run on under the next.
- Leave **markers** (notes, to-dos, problems) at the playhead with M.
- Undo and redo work for every change.

## Sound and text

- Drag sounds from the Sound stage or the library onto the audio lane.
- The text lane holds titles, lower thirds, captions, subtitles and credits.
- Select a text to style single words (bold, italic, underline, a colour, smaller or bigger) and to drag it on the picture. It snaps to the centre and to the safe area, and turns red where some screens could cut it off.
- Subtitles that are too fast to read are marked on the lane.

## Working with the Film Editor

The **Film Editor** can cut too. Its changes arrive as a **proposal**, like tracked changes: play it, then keep or reject each change. Mark a stretch with In and Out (I and O) and your next message is about just that stretch. The **Critic**, an extra role you add on the Crew page under More roles, watches the film and leaves markers.

## Export

Export renders the scene or the whole film as an MP4 file, faster than real time: in the browser, or with ffmpeg on the local server, where Imp offers to download ffmpeg if it is missing.

## Where films end up

Every finished film is kept in the project. Find them all in the **Library** under **Films**, and the latest in the **Export** panel. Each shows when it was made, by whom and how long it runs, with **Play** and **Save as…**, which asks where to save the MP4. When an agent finishes a film, a notice with **Watch** appears, and its reply in the chat carries the same card.`,
};

export const audioGuide: GuideTopic = {
  id: 'stage-audio',
  area: 'audio',
  title: 'Audio',
  summary: 'A full audio editor: tracks, effects, loudness, recording, dialogue by its words.',
  hint: {
    title: 'Fine-tune sound like in a studio',
    body: 'Open a scene or a single sound as an audio document. Arrange regions on tracks, add effects, set loudness, record from your microphone with R, and edit dialogue by its words.',
  },
  body: `Audio is a full audio editor for anything in the film: a scene's whole soundtrack or a single sound.

## What you can do

- Arrange **regions** on **tracks**, trim, split, fade and move them.
- Add **effects** to a region or a track: EQ, compressor, limiter, noise reduction, and voices such as telephone, radio, robot, megaphone or monster.
- Set **loudness** so the film sounds even from scene to scene.
- **Record** from your microphone at the playhead with R.
- Edit **dialogue by its words**: choose Words, then "Write down what is said". Tap a word and another to pick everything between, then Delete, Silence, or move them with Ctrl+X and Ctrl+V.

## Getting sound in

Drag a sound from the library onto a track (on a tablet, hold it a moment first), or choose "Open in audio editor" on any sound.

## Let the crew do it

The **Sound Editor** mixes, cleans and levels sound with the same tools.`,
};

/** In the order of the stages. */
export const movieGuides: readonly GuideTopic[] = [
  developmentGuide,
  scriptGuide,
  castingGuide,
  designGuide,
  shotsGuide,
  soundGuide,
  editGuide,
  audioGuide,
];
