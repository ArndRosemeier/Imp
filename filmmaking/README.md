# Filmmaking notes

What has been learned from making short films with image, video and sound
models, directed by Claude in the "Director" project. It is kept here so that
the next film starts from what the last ones taught, not from scratch.

This folder is separate from the Imp app. Nothing in `apps/` or `packages/`
reads it, and nothing here is built, linted as app code or shipped.

## How to use it

- **Before a film:** read [playbook.md](playbook.md), then skim
  [lessons.md](lessons.md) and [models.md](models.md). Recheck any model note
  that is older than a few weeks before relying on it.
- **During a film:** follow the playbook's steps and checks. Note anything
  that surprised you while it is fresh.
- **After a film:** add one entry per finding to [lessons.md](lessons.md),
  update [models.md](models.md) where a model behaved differently, change the
  playbook where a lesson changes the process, and add the film to
  [films/](films/README.md).
- **Before committing:** run `pnpm format`, because the repository's checks
  also cover the Markdown and JSON files here.

## What is here

| Path                       | What it holds                                                                 |
| -------------------------- | ----------------------------------------------------------------------------- |
| [playbook.md](playbook.md) | The workflow from brief to delivery: each step, what it produces, the checks. |
| [lessons.md](lessons.md)   | Dated log of findings: what happened, why, and what the workflow does now.    |
| [models.md](models.md)     | What each model is good and bad at, prices and quirks, with the date tested.  |
| [tools/](tools/README.md)  | The scripts that make the films.                                              |
| [characters/](characters/) | Reusable character cards as text.                                             |
| [films/](films/README.md)  | One record per film, with its plan files as worked examples.                  |

## What is not here

No pictures, video or sound, and no keys.

- **Finished films, approved keyframes and the character library** (portraits,
  sheets, voice samples) are on Arnd's Google Drive under `Director/`:
  `Director/movies/<film>/` and `Director/library/characters/<id>/`.
- **Working material** (all takes, rejected frames, ledgers, review data) is in
  the Director project's shared files under `movies/<film>/`.
- **Keys** come from the environment (`OPEN_ROUTER_KEY`) and from a credential
  file outside any repository (`GOOGLE_DRIVE_OAUTH_FILE`).

## How to read the claims

Claude directs these films without being able to watch moving video or hear
sound. Each claim in the log and the model notes therefore says where it comes
from:

- **Arnd** watched or listened, or states it from experience with Imp.
- **Measured** means a number from a tool: a transcript, a pitch, a similarity
  score, a price from a ledger.
- **Inspected** means Claude looked at still frames.
- **Inferred** means a conclusion drawn from the above that nobody has
  confirmed by watching or listening.
