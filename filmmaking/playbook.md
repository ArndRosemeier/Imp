# Playbook

The workflow as it stands after two test films (2026-11-24). It is a working
draft: the films so far are learning exercises, and the aim is a process that
holds for proper short films with a bigger budget. Change it when a lesson in
[lessons.md](lessons.md) says so.

## Principles

1. **Stills first.** A still costs about a cent and can be looked at. A clip
   costs 30 to 70 cents and cannot be watched by Claude. Every decision that a
   still can settle is settled on a still.
2. **Measure what cannot be watched.** Claude cannot see motion or hear sound.
   Transcripts, pitch, frame-to-frame jumps and full-size frames stand in, and
   every report says which of them a claim rests on. Timbre, acting, lip sync,
   rhythm and music quality are Arnd's to judge.
3. **Continuity comes from references.** One hero picture per character, one
   master picture per place, and the same words for look and voice in every
   prompt.
4. **Every paid call goes through the budget guard** and lands in the film's
   ledger. Price the plan before generating anything.
5. **The process is the product.** A film is finished when its lessons are in
   this folder.

## Standing rules from Arnd

- Each new film has its own budget of 20 US dollars (2026-11-24). Ask before
  raising it, otherwise work without asking.
- Spending is tracked and visible on a page while the work runs.
- Every film has a progress page that is updated at every step.
- Work autonomously. Bring back only what is truly Arnd's to decide.
- Drive keeps approved keyframes and final clips, not rejected takes.
- No two characters in one production fill the same voice archetype.

## The steps

Each film lives in a folder `movies/<film>/` with `bible.json`, `shots.json`,
`ledger.json`, `cut.json`, `progress.json`, and `frames/`, `clips/`, `audio/`,
`cut/`. The tools are run from inside that folder.

| #   | Step                    | Produces                                                                                            | Check before moving on                                                                                     |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Brief and budget        | The brief in Arnd's words, the budget, a new `ledger.json` with `budget_usd`, a progress page.      | This folder has been read. Which kind of film is it: one take, or cut?                                     |
| 2   | Scout the models        | A few cheap test clips or stills for anything the film needs that is not in [models.md](models.md). | The film's look and its needs (pinned voices, photoreal faces) fit a model that exists today.              |
| 3   | Story and screenplay    | Scenes and spoken lines.                                                                            | Lines are short enough to be spoken in the shots they will sit in.                                         |
| 4   | Characters              | Per character: portrait, three-view sheet, voice sample, character card.                            | Voice archetypes: no two characters share one. Reuse library characters unchanged.                         |
| 5   | Locations               | One master still per place.                                                                         | Each place reads clearly and has room for the staging the scenes need.                                     |
| 6   | Shot list and edit plan | `shots.json` (size, action, lines, length, references per shot) and the planned cut for each join.  | Dialogue timing, the picture-facts list and staging (see below).                                           |
| 7   | Cost estimate           | The price of one take of every shot, plus stills, sound and an allowance for retakes.               | It fits the budget. If not, ask Arnd before generating.                                                    |
| 8   | Keyframes               | The first frame of every shot, painted from the references.                                         | Every still inspected at full size: faces, costume, place, screen direction, and each listed picture-fact. |
| 9   | Clips                   | Each shot as video with its dialogue and sound.                                                     | Nothing. They go straight to the checks.                                                                   |
| 10  | Checks                  | `review.json`, frame strips, a list of retakes.                                                     | The clip checks below. Retake, lengthen or restage what fails.                                             |
| 11  | Edit and sound          | `edl.json`, music, the cut film.                                                                    | The whole cut is transcribed again and the frames on both sides of each cut are inspected.                 |
| 12  | Deliver and record      | The film to Arnd and Drive, characters to the library, lessons to this folder.                      | Arnd is told plainly what was measured and what still needs eyes and ears.                                 |

## Checks in detail

### At the shot list (step 6)

- **Dialogue timing.** Allow about two and a half words a second, plus a
  second of air at each end. A shot that is too short loses words silently.
- **Picture-facts.** For every line, list each fact it states about the
  picture: who holds what, where something is, which side, what someone is
  wearing. For each fact, confirm that the shot's staging lets the camera show
  it. A plan that asks for a man facing the camera and for something on his
  back contradicts itself, and the image model will resolve the contradiction
  on its own.
- **Screen direction.** In a conversation each person keeps one side of the
  screen and one looking direction. Write the side into every shot.
- **Cuts.** Name the cut for each join (see the list below) so the stills can
  be made to serve it.

### On the keyframes (step 8)

- Look at every still at full size, not only on a contact sheet.
- Compare with the references: face, hair, costume details, props.
- Check each picture-fact from step 6. A still that does not show what a line
  claims is repainted. Do not let it pass in the hope that the line will carry
  it.
- Check screen direction and eyelines against the neighbouring shots.

### On the clips (step 10)

- **Words.** Transcribe each clip and compare with the script
  (`review.py`). Anything below a full match is read by hand: a name spelt
  differently is fine, a missing word is a retake with a longer shot.
- **Voices.** Pitch per speaker (`voicecheck.py`) shows whether voices stay
  apart and whether one drifts between shots. It says nothing about timbre.
- **Hidden cuts.** The biggest frame-to-frame jump inside a clip. Normal is
  around 0.01 to 0.04. A value near 0.25 is a cut the model made by itself.
- **Picture-facts again.** Pull full-size frames from the start, middle and
  end of every shot that has a listed fact and check it. Things can appear or
  move during a clip that were not on the first frame.
- **What was not checked.** Say so. Until Claude can watch a clip, motion is
  unverified, and Arnd is told which shots carry the most risk.

## Two kinds of film

### A film with cuts

Nothing has to join frame to frame. What must match across a cut is the
people, the place, the light and who is on which side of the screen. All of
that comes from the references: every still is painted with the character
portraits (and the sheet for full-body or back views) and the location master
as reference pictures, and the same look text.

Cuts that have been used and how they are made:

- **J-cut and L-cut.** Each clip's sound may start before or end after its
  picture while staying in sync with it. The edit list carries a `lead` and a
  `tail` per shot.
- **Graphic match cut.** Made on the stills: crop both frames until the
  matching shapes sit on the same pixels, and tell the outgoing shot to end on
  its own first frame.
- **Shot and reverse shot.** Fixed axis, each person keeps their side.
- **Insert, cutaway, reaction shot, cut on action, hard cut to black.**
  Planned in the shot list, need nothing special from the models.

### A film in one take

There are no cuts to hide behind, so each clip must continue the one before.

- One hero reference picture of the subject.
- An **anchor still** for each join, painted from the hero reference. Paint
  each anchor with the previous anchor as a reference too, so that the two are
  reachable from one another in a single move.
- Each clip **starts on the real last frame of the clip before** and **ends
  on the next anchor**. The real last frame makes the join exact. The anchor
  stops the subject drifting.
- Put anchors at moments where the subject hangs almost still.
- Known weakness, unsolved: motion eases to a near stop at each anchor. See
  the lessons log.

## Characters

A character is a folder in the library with a portrait (the hero reference
for every still), a three-view sheet, a voice sample and a card. The cards are
in [characters/](characters/).

- For stills, pass the portrait (and sheet) as reference pictures and repeat
  the card's `look` text.
- For a spoken line, write: `<tag>, says in <voice_prompt>: "..."`.
- Keep `look`, `voice_prompt` and `tag` word for word the same between shots
  and between films.
- Each card names a `voice_archetype`. On casting, compare the archetypes of
  everyone in the production. Fix a clash by changing a look or an age before
  any shot is rendered, because the look largely decides the voice.

## Money

- `film.py` refuses a call that would pass the film's budget and writes every
  call to `ledger.json`. Nothing is generated around it.
- A video job is charged when it starts, not when it finishes.
- Price the shot list (`shoot.py cost`) and add stills, sound and retakes.
  The second film needed a retake on about one shot in six.
- After each batch, bring the spend page up to date.

## Practical notes

- The project's shared file mount is unreliable for running scripts. Work on
  local disk and copy to the shared files at milestones.
- Copy large files to local disk before uploading them to Drive.
- Files go to Drive with `drive_upload.py`, which has no size limit. The Drive
  connector stops at about 3 MB a file.
- Sharing a file by public link needs Arnd's explicit yes each time.
