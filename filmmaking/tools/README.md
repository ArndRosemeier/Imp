# Tools

The scripts that made the films, copied as they were on 2026-11-24. They are
working scripts, not a library: short, written for one job, and run from
inside a film's folder (or with `FILM_ROOT` set to it).

The working copies live in the Director project's shared files under `tools/`
and may be ahead of this snapshot while a film is being made. Bring them over
again when a film is finished.

| Script            | What it does                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `film.py`         | Every paid OpenRouter call (image, video, music, sound effect, speech). Checks the budget first, writes `ledger.json` after.                                  |
| `shoot.py`        | Films a movie with cuts from `shots.json` and `bible.json`: `keys` paints stills, `sheet` builds a contact sheet, `clips` films, `cost` prices the shot list. |
| `chain.py`        | Films the continuing clips of a one-take movie in order, each starting on the real last frame of the one before.                                              |
| `check.py`        | Free continuity checks for a one-take movie: hidden cuts, similarity at the joins, subject colour.                                                            |
| `review.py`       | Reviews the chosen takes of a movie with cuts: transcript against script, pitch, hidden cuts, loudness, frame strips.                                         |
| `voicecheck.py`   | Pitch per second and a transcript for any clip or sound file.                                                                                                 |
| `edit.py`         | Cuts the movie from `edl.json` and `cut.json`, including J-cuts, L-cuts, music beds and a title.                                                              |
| `progress.py`     | Builds a film's progress page from `progress.json` and its ledger.                                                                                            |
| `drive_upload.py` | Uploads files of any size to Google Drive, lists folders, and can share a file by link.                                                                       |
| `sync.sh`         | Example of building the spend summary and copying a film folder to the shared files. Paths are specific to the first film.                                    |

## What they need

- Python 3 with `requests`, `Pillow`, `numpy` and `librosa`, and `ffmpeg` on
  the path.
- `OPEN_ROUTER_KEY` in the environment. It is never printed or stored.
- For `drive_upload.py`, a credential file whose path is given in
  `GOOGLE_DRIVE_OAUTH_FILE`. It belongs outside any repository.

## Known rough edges

- `film.py` still calls itself the "leaf journey pipeline" in its header, and
  `check.py` has a colour check written for the leaf.
- `sync.sh` has fixed paths.
- There is no check yet that compares what a line states with what the
  picture shows. The playbook does it by hand.
