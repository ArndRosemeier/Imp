# Lessons log

One entry per finding, newest film last. Each entry says what happened, why,
what the workflow does about it now, and where the finding comes from (see
"How to read the claims" in the [README](README.md)). Add to the end. Do not
rewrite old entries: if a later film overturns one, add a new entry and mark
the old one "superseded by".

Template:

```md
### Short name of the finding

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:**
- **Why:**
- **Now:** what the workflow does about it
- **Source:** Arnd | measured | inspected | inferred
- **Status:** in the playbook | open | superseded by ...
```

---

## The Leaf (one take, 2026-11-24)

### An end frame is approached, not reached

- **Date / film:** 2026-11-24, The Leaf
- **What happened:** A clip told to end on a painted anchor still lands near
  it but not on it. The similarity between the anchor and the real last frame
  was about 0.6 (SSIM). Two clips pinned to the same anchor from both sides
  would not have joined.
- **Why:** The video model treats the last frame as a target, not a
  constraint.
- **Now:** Each clip starts on the real last frame of the clip before, taken
  from the file, and uses the anchor only as its end target. Joins made this
  way measured 0.86 to 0.92.
- **Source:** measured
- **Status:** in the playbook

### An anchor that cannot be reached in one move causes a hidden cut

- **Date / film:** 2026-11-24, The Leaf
- **What happened:** One clip contained a cut the model made by itself. Its
  biggest frame-to-frame jump was 0.25, against about 0.03 for a normal clip.
- **Why:** The end anchor showed a place that had nothing in common with the
  start, so there was no continuous way to get there.
- **Now:** Each anchor is painted with the previous anchor as a reference, so
  the two belong to the same space. Every clip is checked for its biggest
  jump.
- **Source:** measured
- **Status:** in the playbook

### Motion pauses at the joins

- **Date / film:** 2026-11-24, The Leaf
- **What happened:** The film very probably hesitates at each of its four
  joins.
- **Why:** Motion slows towards the end of a clip as the model settles on the
  anchor, and the next clip starts from rest.
- **Now:** Nothing yet. Two ideas are untested: hand over from a frame about
  half a second before the end, while things still move, and try models that
  take the previous clip as video input.
- **Source:** inferred from frames. Arnd has not yet commented on the film.
- **Status:** open

### The shared file mount is unreliable for running scripts

- **Date / film:** 2026-11-24, The Leaf
- **What happened:** Scripts run on the project's shared files lost their
  working directory, and listings lagged behind writes.
- **Why:** It is a network mount.
- **Now:** Work on local disk, copy to the shared files at milestones.
- **Source:** observed while working
- **Status:** in the playbook

---

## The Kobold Cave (cuts, two characters, dialogue, 2026-11-24)

### A film with cuts needs different continuity

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** 19 shots held two characters and four places without any
  frame-exact join.
- **Why:** Across a cut the eye compares people, place, light and screen
  side, not pixels. All of these come from references.
- **Now:** Portrait and sheet per character, a master still per place, the
  same look text everywhere. The one-take method is kept for films without
  cuts.
- **Source:** inspected (frames on both sides of all 18 cuts)
- **Status:** in the playbook

### Stills are the cheap checkpoint

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** 2 of 19 keyframes were repainted, both for staging: one
  wrong eyeline across the table, one hood up that should have been down.
  Neither was a wrong face.
- **Why:** A still costs one cent and can be inspected. The same mistake found
  in a clip costs 30 to 60 cents.
- **Now:** Every shot's first frame is painted and inspected before any video
  is paid for. Screen direction is checked on the stills.
- **Source:** inspected, prices from the ledger
- **Status:** in the playbook

### Dialogue needs room

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** Three shots lost words and were filmed again, each a
  little longer.
- **Why:** The video model drops words without warning when a shot is too
  short for its line.
- **Now:** About two and a half words a second plus a second of air at each
  end, set at the shot list. Every clip is transcribed and compared with the
  script before it goes into the cut.
- **Source:** measured (transcripts)
- **Status:** in the playbook

### What a line says and what the picture shows were never compared

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** In the last shot the line says Brann has a dart in his
  backside. The picture shows it at the front. Arnd saw it on first viewing
  and chose to leave the film as it is.
- **Why:** Three things together. The shot plan contradicted itself: Brann
  three-quarters towards the camera, and a dart in the back of his trousers.
  On the still there was no dart at his back, which Claude noticed and let
  pass, expecting the line to carry the joke. The dart at the front only
  appears in the moving clip, which was reviewed as four small frames on a
  contact sheet. And no check asked the question: the checks confirmed the
  line was spoken, the characters matched and there was no hidden cut.
- **Now:** At the shot list, every fact a line states about the picture is
  listed and the staging is checked for whether the camera can show it. On the
  stills and again on full-size frames from the clip, each fact is checked. A
  still that contradicts a line is repainted.
- **Source:** Arnd found it. The cause is Claude's reading of its own records.
- **Status:** in the playbook

### Nothing is watched or heard

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** The film was delivered without anyone having watched it
  move or listened to it.
- **Why:** Claude cannot do either. Small frames on a contact sheet hide
  details.
- **Now:** Frames are inspected at full size. Reports say what was measured
  and what was not, and name the shots where motion matters most, so Arnd
  knows where to look.
- **Source:** inferred from the dart
- **Status:** in the playbook. A way for Claude to review motion is open.

### The picture decides the voice

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** Voice coherence across the film was "pretty good,
  considering that it can not be enforced" (Arnd).
- **Why:** Arnd's finding from Imp, checked there earlier: the character's
  picture largely fixes the voice the video model gives it.
- **Now:** Voices are held by the same portrait and the same `voice_prompt`
  words in every shot.
- **Source:** Arnd (listening, and experience with Imp). Claude's
  measurement adds that pitch kept the two men apart, Brann at about 85 to
  110 Hz and Fenn at about 130 to 180 Hz, and that Fenn's moved between
  shots.
- **Status:** in the playbook

### Voice clones: one archetype, one character

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** Not a fault in this film, a warning for the next: "The
  next burly fighter will probably sound pretty much the same" (Arnd).
- **Why:** If the look decides the voice, look-alikes sound alike.
- **Now:** Arnd's rule: no two characters in a production fill the same voice
  archetype. Each character card names its archetype. A clash is fixed at
  casting by changing a look or an age.
- **Source:** Arnd
- **Status:** in the playbook

### A recorded voice can be pinned, but not with photoreal faces

- **Date / film:** 2026-11-24, The Kobold Cave (tests after delivery)
- **What happened:** Gemini Omni refused a voice recording as a reference.
  Seedance accepted the two voice samples, by public link, with a stylised
  first frame. It had refused the photoreal stills of the same characters
  ("may contain real person"). In the first take the two voices came out
  swapped. In the second, with each recording named in the prompt, each
  speaker's pitch was near his sample: Brann about 105 Hz against 83, Fenn
  about 187 against 197.
- **Why:** Model limits and safety rules. The swap happened because nothing
  in the first prompt said whose voice was whose.
- **Now:** A film that needs pinned voices is made in a non-photoreal look on
  a model that takes recordings, and the prompt binds each recording to a
  person ("@Audio1 is the voice of Brann, the man on the left"). Photoreal
  films hold voices by description and accept some drift.
- **Source:** measured (pitch). Arnd has the two test clips to listen to.
  Arnd allowed the public links for these two samples.
- **Status:** in the playbook and the model notes. Retest when models change.

### Cuts in sound and picture are plain data

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** J-cuts, L-cuts and a graphic match cut worked on the
  first try.
- **Why:** A J-cut or L-cut is only a clip's sound starting early or ending
  late while staying in sync with its picture. A match cut is two stills
  cropped until the matching shapes share the same pixels.
- **Now:** The edit list carries `lead` and `tail` per shot. Match cuts are
  prepared on the stills.
- **Source:** inspected (frames) and measured (timeline). How the cuts feel is
  Arnd's to say.
- **Status:** in the playbook

### What the film cost

- **Date / film:** 2026-11-24, The Kobold Cave
- **What happened:** $8.60 for 73 seconds: $7.65 video, 30 cents stills,
  8 cents music, the rest tests. With the later voice tests, $9.12. Three in
  four first takes were usable. The estimate before generating was $9 to $10.
- **Why:** Video is almost the whole bill, at about 7 cents a second filmed.
  87 seconds were filmed for 73 in the cut.
- **Now:** Estimates are built from seconds of video plus a retake allowance.
- **Source:** measured (ledger)
- **Status:** in the playbook
