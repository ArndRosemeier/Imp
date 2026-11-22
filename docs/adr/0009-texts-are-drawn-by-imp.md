# 9. Texts are part of the cut and drawn by Imp

Date: 2026-11-21 · Status: accepted

## Context

Films need titles, lower thirds, subtitles, in-frame captions and credits.
Video models write text badly, so text cannot come from the clips. Agents
must be able to do everything a person does with text, and the preview must
show what the exported film shows.

## Decision

1. **Texts live in the scene's cut** (`SceneCut.texts`), so they are undone,
   drafted by agents and reviewed as tracked changes (part `text` in
   `drafts.ts`) like every other edit. Commands: `movie.edit.text.add/set/remove`.
2. **A text keeps its own time or follows an anchor**: a piece of the picture
   (`item`) or a heard line (`shot`, `placement`, `lane`, as `spoken` lists
   them), covering a share `from`–`to` of it. Subtitles made by
   `movie.edit.subtitles.generate` are anchored to their lines, so they keep
   up with trims and new takes. A text whose anchor is gone is kept but
   flagged `orphaned` and left out of the film. Generated texts (`generated`)
   are replaced when made again; a text changed by hand stops being generated.
3. **Styles are film-wide** (`movie/text-styles`): one built-in style per kind
   (resettable) plus the film's own. `movie.edit.text.style.*`. Style changes
   apply at once and are not drafted.
4. **One drawing function** (`apps/web/src/host/text-draw.ts`) draws texts for
   the Edit preview (a canvas over the video), the offline film renderer and
   the real-time recorder fallback, with the same bundled fonts loaded under
   their own names on the page and in the worker (`text-fonts.ts`). Sizes and
   places are shares of the frame. Motion (`textMotion`) is pure and shared.
5. **Export**: `FilmPlan.texts` carries the texts in film time with resolved
   styles; title cards carry the title style. `movie.edit.export` burns
   subtitles in unless `subtitles: false`; `movie.edit.subtitles.export`
   writes SRT or WebVTT timed to the film. End credits
   (`movie.edit.credits.generate`) are a rolling text anchored to a black
   title card, so lengthening the card slows the roll.

## Consequences

- A server-side renderer must draw texts the same way; it does not exist yet.
- One subtitle language for now; a language field on texts can come later.

## Addendum (2026-11-22): styled words

Words carry a small markup (`packages/mode-movie/src/text-markup.ts`):
`*italic*`, `**bold**`, `_underline_` (the marks Fountain screenplays use),
and `{#rrggbb small big|…}` spans. It stays plain text, so agents and people
write it alike and nothing in storage changes. The drawer lays out runs of
one look and draws them on one baseline; weights a family does not have are
thickened by the drawer itself (`FAMILY_WEIGHTS`), never by the browser, so
the local server's rasterizer draws the same letters. Generated subtitles and
credits escape the words they take from elsewhere (`escapeMarkup`); subtitle
files turn the marks into `<i>`, `<b>`, `<u>` and (SubRip) `<font color>`.
