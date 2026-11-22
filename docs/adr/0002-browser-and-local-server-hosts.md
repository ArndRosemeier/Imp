# 2. Run in the browser, with an optional local server

Date: 2026-11-20 · Status: accepted

## Context

A user should be able to start by opening a web page. Long agent runs and large
media are more reliable with a process on the user's machine. Hosting anything
beyond static files is not wanted.

## Decision

The core is host-agnostic. It runs in a worker in the browser by default, and
in an optional downloadable local server that serves the same UI. The server is
pure JavaScript without native modules, so it can ship as an npm package and as
cross-compiled executables. Executables are unsigned for now.

## Consequences

- Host services (storage, clock, ids, later blobs, jobs and secrets) are
  injected interfaces with one implementation per host.
- One contract test suite runs against every implementation.
- In browser mode the OpenRouter key lives in the browser, encrypted with a
  non-extractable AES-GCM key the browser keeps in IndexedDB (2026-11-22), and
  agent runs pause while the tab is closed.
- In server mode the key lives on the server, in `secrets/openrouter-key` in
  the data folder (mode 0600); the page passes a new key on and never holds it.
- The server does not require ffmpeg: it offers a hash-checked download of a
  static build (`system.ffmpeg.install`) and, without it, films are recorded in
  the browser.
