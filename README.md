# Imp

A toolbox for creating content with LLM agents you hire for the job. Movie
creation is the first working mode: development, script and casting, with
storyboard, shots, sound and edit to follow.

Everything a person can do in Imp, an agent can do too, because both go through
the same typed command layer. See [docs/architecture.md](docs/architecture.md).

## Status

Early, and usable in the browser: after connecting an OpenRouter key and
choosing a coordinator model, you can talk to the coordinator, which acts
through the same commands as the UI. The movie mode does not exist yet.

The current `main` is published at <https://arndrosemeier.github.io/Imp/>.

## Development

Requires Node 22 or newer and pnpm 10.

```sh
pnpm install
pnpm check        # format, lint, type check and tests with coverage
pnpm --filter @imp/web dev   # the web app at http://localhost:5173
```

| Script               | Does                                              |
| -------------------- | ------------------------------------------------- |
| `pnpm test`          | Runs the tests                                    |
| `pnpm test:coverage` | Runs the tests and enforces coverage thresholds   |
| `pnpm lint`          | ESLint with type-aware rules, no warnings allowed |
| `pnpm typecheck`     | Strict TypeScript across all packages             |
| `pnpm format`        | Formats everything with Prettier                  |

## Adding a capability

Declare a command, register it, and test it. It is then available to the UI and
to agents without further work.

```ts
import { z } from 'zod';
import { defineCommand } from '@imp/core';

export const projectRename = defineCommand({
  id: 'project.rename',
  title: 'Rename project',
  description: 'Changes the display name of a project.',
  effect: 'write',
  input: z.object({ projectId: z.string(), name: z.string().min(1) }),
  output: z.object({ projectId: z.string(), name: z.string() }),
  handler: async ({ runtime }, input) => {
    await runtime.store.batch([
      { type: 'put', key: `projects/${input.projectId}/name`, value: input.name },
    ]);
    return input;
  },
});
```
