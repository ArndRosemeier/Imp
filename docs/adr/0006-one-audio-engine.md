# 6. One audio engine for editing, listening and export

Date: 2026-11-20 · Status: accepted

## Context

Imp gets an audio editor with the abilities of a desktop editor (selection,
cut and paste, fades, effects, many tracks, export), and the Edit stage
already lays sounds on a scene's audio lane. Everything must run the same in
the browser worker and in the local server, with no native modules, and every
ability must be a command agents can use. The plan is the "Imp audio editor
plan" document.

## Decision

1. **A mode-agnostic package, `@imp/audio`.** It holds the sound placement
   type, the renderer, decoding and the `audio.*` commands. The Edit stage's
   `SoundPlacement` moved here unchanged; fields added since have defaults,
   so stored cuts keep reading.
2. **One renderer in TypeScript.** Placements are mixed block by block on
   48 kHz stereo float samples. Playback, analysis, agent excerpts and export
   all use it, so what is heard is what is measured and exported. Times stay in
   seconds and snap to the 48 kHz grid.
3. **Decoding is a replaceable codec.** `AudioCodec` turns file bytes into
   samples. The default decodes WAV in TypeScript and MP3, FLAC, Ogg Vorbis
   and Ogg Opus in WebAssembly (MIT-licensed `@audio/decode-*` packages),
   loaded on first use, identically in both hosts. A host may wrap it to add
   formats it decodes natively.
4. **What decoding learns is cached beside the file.** Length, levels and a
   waveform overview (min and max per 256, 4 096 and 65 536 frames) are stored
   in the blob store under `<file key>.audio/<fingerprint>/`, rebuilt when the
   file changes and swept with its project. Decoded samples stay in memory only,
   within a budget, because decoding again is quick and samples are about ten
   times the size of the file.

## Consequences

- The web worker is a module worker so the decoders load as separate files.
- The sound inside video clips (AAC) is not decodable yet. The only
  WebAssembly AAC decoder (FAAD2) is under the GPL, which would bind all of
  Imp. Browsers can decode AAC through WebCodecs, and the local server can use
  an installed ffmpeg; that wrapper comes with the editor's first phase.
