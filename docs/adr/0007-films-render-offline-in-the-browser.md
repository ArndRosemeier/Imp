# 7. Films render offline in the browser, and agents can export them

Date: 2026-11-21 · Status: accepted

## Context

Exporting a scene or the film played the cut in real time and recorded the
tab (canvas capture and MediaRecorder). That only works while the tab is
visible and takes as long as the film, so agents, which work without a
screen, could not export at all. Imp exists to make films of any length from
many clips, so exporting has to be a command like every other ability.

## Decision

1. **`movie.edit.export` renders a film into the project.** It lays the
   chosen scenes one after the other (`planFilm`): the pictures with trims,
   fades and title cards, and per scene the sound as the audio editor sees it
   (the scene audio link). It waits until the file is done and returns a
   record (length, size, codecs, items not ready, sounds left silent).
   `movie.edit.export.list`, `.cancel` and `.delete` go with it. One film
   renders at a time; progress is written to the record about once a second,
   so the Edit screen and agents see the same state.
2. **The sound is mixed by the one audio engine** (ADR 6), scene by scene,
   so volumes, gain, fades, pan and character lanes sound as they do in the
   audio editor, and only the scene being rendered is kept decoded.
3. **The picture is a host service, `FilmRenderer`.** The browser host
   renders in its worker with WebCodecs through `mediabunny` (MPL-2.0, used
   unmodified): clips are demuxed and decoded, each frame is drawn on an
   OffscreenCanvas, encoded (H.264 first, then HEVC, VP9, AV1; AAC sound,
   else Opus) and muxed into an MP4. Size and rate follow the clips unless
   asked for. No screen is needed and it runs faster than real time.
4. **The file is kept in parts** of 16 MiB in the blob store (`PartWriter`),
   so no single value or buffer holds a whole film; the MP4 header is filled
   in last by writing into the first part again. The page joins the parts
   into one download.
5. **Clip sound is heard in exports** through the host's MP4 sound decoder
   (WebCodecs in the browser), which the film's mix shares with the audio
   commands, decoded samples included.

## Consequences

- Where WebCodecs is missing, the Edit screen falls back to the real-time
  recorder, which still needs a visible tab. Agents cannot export there.
- The local server has no renderer yet, so agents cannot export in server
  mode; one that runs ffmpeg can implement `FilmRenderer` later without
  changing the commands.
- The renderer needs a real browser and are left out of the
  Node coverage figures; they are checked by rendering in Chromium.
- A render that a reload interrupts is reported as failed and can be started
  again.
