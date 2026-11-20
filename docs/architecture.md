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
| `@imp/providers`  | Generation provider interface and the OpenRouter adapter             | planned |
| `@imp/agents`     | Crew, tasks, the tool loop, approvals, budgets, the coordinator      | planned |
| `@imp/mode-movie` | The movie mode: development, script, casting                         | planned |
| `@imp/ui`         | Design tokens and shared components                                  | planned |
| `apps/web`        | The workspace, and the browser host that runs the core in a worker   | started |
| `apps/server`     | The optional local server that runs the same core on Node            | planned |

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

## Modes

A working mode (movie first) is a package that contributes commands, agent
roles, stages and views. The core knows nothing about scripts or shots, so a
new mode is a new package and not a change to the core.

## The web app today

`apps/web` assembles the core in `src/host/imp.ts` and renders the workspace
from it. Views read through commands with `useLive`, which reads again when the
store changes, so the screen stays current whoever made the change. The
OpenRouter key is held in `localStorage`, outside the key-value store, so no
command can return it.

The core currently runs on the page's main thread behind the same registry
interface. Moving it into a worker is planned and does not change any view.
