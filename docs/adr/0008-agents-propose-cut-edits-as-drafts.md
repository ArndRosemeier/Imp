# 8. Agents propose cut edits as drafts, like tracked changes

Date: 2026-11-21 · Status: accepted

## Context

Editing by hand and editing through the Film Editor must be equally good.
An agent that changes the cut directly leaves the person to find out
afterwards what moved, and its work mixes with theirs in one undo history.
Agents also cannot watch a cut, so they need the cut in a form they can read
and pictures of it they can look at.

## Decision

1. **An agent's `movie.edit.*` writes go into a draft of the scene's cut**
   (`movie/edit-drafts/<sceneId>`), never into the cut. The draft starts as
   a copy of the cut on the agent's first change and keeps that copy as its
   base. The editing commands are unchanged; `open()` and `commit()` in
   `edit.ts` route by actor. An agent reads and undoes its own draft. The
   setting `edit.agent-drafts` set to `false` lets agents edit directly.
2. **Changes are worked out, not recorded.** `diffCut` compares base and
   draft piece by piece by id (items, placed sounds, lane lines): added,
   removed, changed (with the fields) and moved (items outside the longest
   common order). `applyChanges` carries chosen changes onto the cut as it is
   now, so the person can keep editing while an agent works; a change to a
   piece the person also changed is flagged as a conflict.
3. **Review commands**: `movie.edit.draft.get`, `.keep` (all or by id; one
   undo step; an agent cannot keep a draft it worked on), `.reject` (by id,
   undoable within the draft) and `.discard` (destructive).
4. **Range requests**: `movie.edit.request` stores the instruction and the
   stretch on the draft and returns context for `crew.ask`. On the Edit
   screen, In and Out (keys I and O) mark a stretch that the crew panel
   attaches to the next message. Changes outside the stretch are flagged.
5. **What agents read**: `movie.edit.get` lists every spoken line with who
   says it and when; `movie.edit.edl` writes a scene out as an edit decision
   list; `movie.edit.range` reads a stretch; `movie.edit.frames` and
   `movie.edit.range` show stills taken from the trimmed clips. Stills come
   from a host service, `FrameGrabber` (mediabunny in the browser worker,
   ffmpeg on the local server), and are kept beside the clip so a second
   look decodes nothing.

## Consequences

- Nothing an agent does to a cut reaches it without a person's say, and the
  person sees each change on the timeline before keeping it.
- Commands that write a cut outside `movie.edit.*` (the scene audio link of
  the audio editor) still write the cut directly; agent edits there are not
  drafts yet.
- New editing commands must go through `open()` and `commit()` to take part.
