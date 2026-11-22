# Working on Imp

## Checks before merging

- Pull requests merge after the fast checks (`CI` workflow) are green. Run
  `pnpm check` locally first; with ffmpeg installed, so the server's ffmpeg
  tests run and coverage stays above its thresholds.
- The slow checks (`Slow checks` workflow, `pnpm test:slow`, Playwright in
  `apps/web/browser/`) do not run on pull requests. Run them by hand on your
  branch (Actions → Slow checks → Run workflow, or `pnpm test:slow` locally)
  when the change touches film export or the renderer, the app's layout,
  touch handling, or anything that only a real browser shows. Run them
  before calling a release. They also run nightly on `main`.
- Keep the fast checks fast. A test that takes more than a few seconds
  should be made faster (for example, compare large byte arrays with a
  loop (`findIndex`), not `toEqual`) or moved to the slow checks. Large test
  files run on one worker, so split a file that grows past a few seconds.
- Every merge to `main` bumps the version by 0.001 on its own; add a
  `changes/<branch-or-feature>.md` entry for What's new (see
  `changes/README.md`).
