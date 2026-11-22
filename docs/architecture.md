# Architecture

Imp is a toolbox for creating content with hired LLM agents. This page is the
short version of the design; the decisions behind it are recorded in
[`docs/adr`](./adr).

## The rule everything follows

Every capability is a **command**: a typed, described, validated function
declared once with `defineCommand`. The UI, the hired agents, the coordinator
and outside callers all execute commands through the `CommandRegistry` and have
no other way to read or change state. Whatever a person can do, an agent can do,
because both are doing the same thing.

From one definition the system derives:

- a typed call for the UI (`registry.execute`),
- an LLM tool with a JSON Schema for agents (`toToolDefinitions`),
- an untyped call for HTTP and other callers (`registry.executeById`),
- an entry in the activity log for every execution, attributed to its actor.

Each command declares an **effect**: `read`, `write`, `spend` or `destructive`.
The execution policy keys on it. By default a person may run anything, and an
agent must ask before spending money or destroying something.

## Parts

| Package           | Holds                                                                | Status  |
| ----------------- | -------------------------------------------------------------------- | ------- |
| `@imp/core`       | Commands, registry, policy, activity log, storage contract, settings | started |
| `@imp/providers`  | Generation provider interface and the OpenRouter adapter             | started |
| `@imp/agents`     | Crew, tasks, the tool loop, approvals, budgets, the coordinator      | started |
| `@imp/audio`      | Sound placements, the mixing renderer, decoding, `audio.*` commands  | started |
| `@imp/mode-movie` | The movie mode: development, script, casting                         | started |
| `@imp/ui`         | Design tokens and shared components                                  | planned |
| `apps/web`        | The workspace, and the browser host that runs the core in a worker   | started |
| `apps/server`     | The optional local server that runs the same core on Node            | started |

## Two hosts, one core

The core never touches a host API. It receives a `CoreRuntime` (a store, a
clock, an id source) from whichever host is running it:

- **Browser mode**: the core runs in a worker in the page. Nothing is installed
  and only static files are hosted. Agent runs pause while the tab is closed.
- **Local server mode**: a downloadable program runs the same core on the
  user's machine, so agents keep working in the background.

Lint rules forbid Node and DOM access inside `packages/core/src`, and the core
compiles without Node or DOM type libraries.

## Storage

Storage is a small contract, `KeyValueStore`: get, list by prefix, an atomic
batch of writes, and change subscriptions. Values are JSON. Media will live in
a separate blob store. Every implementation must pass the shared suite
`describeKeyValueStoreContract` from `@imp/core/testing`.

## The library

Every asset of a project is in one library (`library.*` commands in
`@imp/core`), whatever made it. The library stores nothing of its own sources:
each mode or package hands it a `LibrarySource` that lists what it already
keeps (the movie mode its portraits, clips, sounds and scenes; the world its
pictures; the audio editor its documents), and the host passes them all to
`createLibraryCommands`. A modality is a string, so a later one (3D, comics)
is a new source, not a change to the library. Its own records are only what
was imported or written there, under `projects/<id>/library/`, plus tags,
stars and notes for any asset. In the interface, a drop target is
`useLibraryDrop`; it also appears in the asset's "Use in" menu, which is the
path that needs no dragging.

The library's Crews tab shows saved crews (`crew.saved.*` in `@imp/agents`).
Unlike assets they belong to the workspace, under `saved-crews/`, so any
project can load one. A saved crew copies the custom roles its agents hold;
loading it brings back any that were deleted and never dismisses the
coordinator, which may be the agent doing the loading.

## Help

Imp explains itself from one set of pages, the guide (`help.*` commands in `@imp/core`). Each stage of a mode carries its own page, with the short tip shown the first time the stage opens (`Stage.guide`); pages about Imp as a whole live in `packages/host/src/guide.ts`. The help panel, the tips, and agents that answer questions all read the same pages. Whether tips are shown, and which were closed, are the settings `help.enabled` and `help.dismissed`, so turning all help off is one command a person or an agent can run.

## Modes

A working mode (movie first) is a package that contributes commands, agent
roles, stages and views. The core knows nothing about scripts or shots, so a
new mode is a new package and not a change to the core.

## The web app today

`apps/web` assembles the core in `src/host/imp.ts` and runs it in a worker
(`src/host/worker.ts`). The interface reaches it only through messages
(`src/host/protocol.ts`): run a command as the user, be told when the store
changes under a prefix, fetch a stored file, list models, check the key. Only
plain data crosses, so the same protocol also reaches the local server. Views
read through commands with `useLive`, which reads again when the store changes,
so the screen stays current whoever made the change. The OpenRouter key is held
in `localStorage` on the page, outside the key-value store, so no command can
return it; the page hands it to the worker, which keeps it in memory.

Films are exported by a command too (`movie.edit.export`, ADR 7): the core
lays out the picture and mixes the sound, and the browser host's worker
renders the MP4 with WebCodecs, offline and faster than real time, so agents
export as people do.

Agents edit a cut through the same `movie.edit.*` commands, but their changes land in a draft that the Edit screen shows as tracked changes for the person to keep or discard (ADR 8). Agents read a scene as an edit decision list and look at stills taken from the clips.

The text lane (titles, lower thirds, captions, subtitles, credits) is part of each scene's cut. Texts keep their own time or follow a piece or a spoken line, film-wide text styles set their look, and one drawing function in the browser host draws them for the preview and the exported film (ADR 9).

A shot keeps its earlier ready clips as takes (`Shot.takes`, newest first, at most 20), so a new clip never destroys the one it replaces and the cut can be switched back with `movie.shot.take.use`. Split edits (`movie.edit.item.roll`) first lay the sound an item plays with its picture on the audio lane, at the same time and length, then roll the picture cut between two items; sync and scene length stay as they were, and texts that followed the line follow its placement.

Rescue tools (speed, reverse, a held last frame, a still or moving punch-in) are fields of a cut item. One pure module, `piece-time.ts`, maps a piece's time to its clip's time and places a zoomed picture; the Edit preview, the film renderer, the stills agents look at and the scene's sound all use it, so they agree. Off speed or reversed, a piece's own sound is silent. The renderer reads backwards runs forwards a few frames at a time (`frame-order.ts`), because decoders only move forwards from a key frame.

Transitions are fields of a cut item too: how it comes in after the piece before (a cut, a dissolve, a dip to black or white, or a wipe) and for how long. A dissolve or wipe starts the piece before the one before it ends, by at most half of either, so the scene grows shorter; a dip fades out and in at the cut without overlap. One pure module, `transitions.ts`, works out the overlap, the dips and how much black and white lies over a piece at each moment; the cut's layout, the scene's sound (which crossfades over an overlap), the Edit preview (two video screens that take turns) and the film renderer (which composites two clips frame by frame) all take their timing from it.

The Edit stage opens on the whole film: a strip with one block per scene, as long as the scene and coloured by how finished it is, zooming from a feature seen whole to one scene; opening a scene shows its own timeline below, which zooms down to single frames. Playback can run on from one scene into the next. Markers (notes, to-dos and problems) are kept per scene apart from the cut (`movie/markers/<sceneId>`), so an agent's note shows at once instead of waiting in a draft and undo leaves notes be; each follows the piece of picture it was put on. `movie.edit.film.edl` writes the whole film as one text, scene by scene with film times and markers, so an agent can reason about how scenes join without reading media.

Colour is a grade per cut item (exposure, contrast, temperature, tint, saturation) and one look for the whole film (`movie/film-look`, from a preset or by hand). `grade.ts` turns each into an affine colour matrix and combines them, so the film renderer applies one matrix to each frame's pixels and the Edit preview hands the same numbers to an SVG feColorMatrix on its screens. `movie.edit.grade.match` reads a few small frames of two shots through the host's colour sampler (WebCodecs in the browser, ffmpeg on the local server), compares brightness, spread, white balance and colourfulness, and steps a grade until the shot's average colour lands on the reference's; it is a starting point to judge by eye.

A pickup is a shot the edit asks for after the fact (`movie.edit.pickup.request`): it is written into the scene as an ordinary shot with a `pickup` record (why, how long, who asked) and put into the cut at once. Until its clip is ready, the layout gives it its planned length and marks it `placeholder`, so the preview, the film renderer and the EDL show a slate in its place and the scene keeps its timing; when the clip arrives the same item simply plays it. The Clip Designer finds open requests with `movie.edit.pickup.list`. The Critic role reads the film (EDLs, stills through `media.view`) and can write only markers.

`apps/server` is the local server: the same core on files (`file-store.ts`: a
journal for the data, one file per medium), reached over the same protocol by
HTTP, with messages posted and answers on one event stream (`server.ts`). It
serves the built interface and marks the page it serves, which is how the
interface knows to connect to it and not to start a worker. It listens on this
computer only and refuses requests that name another host or come from another
site's page. `pnpm --filter @imp/server build` makes one folder with one script
that needs only Node; the deploy puts it into the site as `imp-server.zip`.

The tests run the whole interface over the same protocol, with both ends in
one thread and every message cloned as between a page and a worker.
