# Model notes

What each model did in the films so far. All were called through OpenRouter.
Every note carries the date it was tested: models and prices change, so
recheck anything old before planning around it.

These notes rest on measurements and on still frames that Claude inspected.
Claude did not watch any clip or listen to any sound. Where Arnd judged
something by eye or ear, the note says so.

## Summary

| Job           | Model                                   | Price when tested          | Tested     | Verdict                                                     |
| ------------- | --------------------------------------- | -------------------------- | ---------- | ----------------------------------------------------------- |
| Video + sound | `google/gemini-omni-1.2-flash`          | $0.0695 per second at 720p | 2026-11-24 | The workhorse. Photoreal people, spoken lines, start frame. |
| Video + sound | `bytedance/seedance-2.0-mini`           | about $0.28 per test clip  | 2026-11-24 | Takes voice recordings, but only with non-photoreal looks.  |
| Stills        | `meta/muse-image`                       | $0.01 per image            | 2026-11-24 | Best value in the pipeline. Holds characters and places.    |
| Voice samples | `bytedance-seed/seed-audio-1-0`         | $0.00 in the ledger        | 2026-11-24 | Too little use to rate.                                     |
| Music         | `google/lyria-3-pro-preview`            | $0.08 per piece            | 2026-11-24 | Delivered the length asked for. Arnd: "a decent job".       |
| Music         | `google/lyria-3-clip-preview`           | $0.04 per piece            | 2026-11-24 | As above, shorter pieces.                                   |
| Transcription | `mistralai/voxtral-mini-transcribe-3-0` | not noted                  | 2026-11-24 | Good enough to check lines. Misspells names.                |

## Gemini Omni 1.2 Flash (video with sound)

Used for 29 clips across both films. About a minute to make an 8 to 10 second
clip.

- **Good:** accepts photoreal stills of people. Starts exactly on the first
  frame it is given. Puts the right line in the right mouth: a transcriber
  heard every scripted line of the second film. Makes its own ambient sound
  from a description.
- **Weak:** drops words when a shot is too short for its dialogue (3 retakes
  in 19 shots). Lands near a requested last frame but not on it (similarity
  about 0.6). Motion slows towards the end of a clip (inferred from frames).
  Makes a hidden cut when the last frame is not reachable from the first.
- **Voices:** cannot be given a voice recording (the request is refused).
  The voice follows the character's picture (Arnd) and the words of the voice
  description, and drifts somewhat between shots (measured as pitch).
- **Prompting:** a line is written as
  `<who, described by look>, says in <voice description>: "..."`. Ask for
  "one continuous shot, no cut inside the shot, no subtitles, no on-screen
  text, no music".

## Seedance 2.0 mini (video with sound)

Two test clips only.

- **Good:** the only model tested that takes a voice recording as a
  reference. With each recording named in the prompt, each speaker's pitch
  landed near his sample.
- **Weak:** refuses photoreal stills of people as possible real persons.
  Fetches audio and video references only from a public web address. Without
  the binding sentence in the prompt it swapped the two voices.
- **Use it for:** stylised or animated films that need pinned voices. Not yet
  used for a whole film.
- **Prompting:** "@Audio1 is the voice of Brann, the man on the left".

## Muse (stills)

42 images across both films, each one cent.

- **Good:** holds a character and a place when given reference pictures
  (portrait, sheet, location master) together with the same look text. Only 2
  of 19 keyframes in the second film needed repainting, both for staging and
  not for a wrong face.
- **Weak:** resolves a contradictory brief by itself and silently, as in the
  dart shot. Eyelines and details such as a hood up or down need checking.
- **Practical:** asking for the size `1920x1080` gives a true 16:9 picture.

## Seed Audio (voice samples)

Three 14 second character samples. The voice is described in the text prompt
itself, not in a separate instructions field. The samples served as reference
for the Seedance test and did not drive either film.

## Lyria (music)

Pro for the first film's score, the clip version for two beds in the second.
Cheap, and each piece came back at the requested length. Claude cannot judge
music. Arnd says Lyria does a decent job.

## OpenRouter video API

- `GET /videos/models` lists what each video model can do and what it costs.
- `POST /videos` with `model`, `prompt`, `duration`, `resolution`,
  `aspect_ratio`, `seed`, `generate_audio` and `frame_images` (each
  `{type: "image_url", image_url: {url}, frame_type: "first_frame" | "last_frame"}`).
- Poll `GET /videos/{id}`, download from `GET /videos/{id}/content?index=0`.
- The job is charged when it starts.

## Open gaps, to retest first when new models appear

1. A fixed voice together with photoreal faces.
2. Control over motion at the end of a clip, so one-take films do not pause at
   their joins. Candidates not yet tried: models that continue from the
   previous clip as video input.
3. A way for Claude to review motion and sound directly.
