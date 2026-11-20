# 6. Project files, templates and copies that ask the person

Date: 2026-11-20 · Status: accepted

## Context

People want to back projects up, move them between computers and between the
browser and the local server, start from templates, duplicate them and copy
single things (a character, a scene) from one project into another. Agents
must be able to do all of it too. Copying can meet something that is already
there, and what to do then is the person's call, not an agent's.

## Decision

- **Everything of a project lives under `projects/<id>/`**, records and files.
  Duplicating, saving a template (`templates/<id>/`) and creating from one are
  one generic tree copy that moves every key inside the records along
  (`createRewriter`). The core knows nothing about what is in a project.
- **A project file is a ZIP** (`<name>.imp.zip`): `project.json` holds the
  records with keys relative to the project, and `files/` the media, stored
  uncompressed. Import always makes a new project and checks every key. Files
  above 4 GB need ZIP64, which is not written yet.
- **Picked files reach the core in parts** (`upload` in the host protocol, 4
  MiB each) under `uploads/`, so the local server's message limit holds; an
  export waits under `exports/` and is removed once the interface saved it.
- **Modes add what only they know** through `Mode.project`: shipped templates,
  a progress summary for the start screen, and a `ResourceCopier` that plans a
  copy (what comes along, what collides) and applies it with a choice per
  collision (overwrite, keep both, skip).
- **Collisions always go to the person.** `project.resources.copy` copies at
  once when nothing collides; otherwise it stores a copy request and returns
  `waiting-for-person`. The app shows every pending request as a dialog, and
  `project.resources.request.resolve` refuses any actor but the person. An
  agent may suggest a choice and give a note; it can look up the outcome later.

## Consequences

- A new mode gets duplicate, export, import and saved templates for free, and
  writes a copier to take part in copying single resources.
- Records must keep keys to their own files under the project prefix, or the
  tree copy cannot move them.
- A copy waits for as long as the person takes; the agent's run does not block.
