# Agents finish and report back

- An agent that runs out of steps no longer stops silently: its last step is always a short summary of what it did, what waits for your approval and what is still left.
- Agents are told when only a few steps remain, so they wrap up in time instead of looping until the limit.
- "Continue where … stopped" after a step limit picks up the task where the agent stopped.
- On a project made from a template, the Screenwriter rewrites the placeholder scenes and "The hero" into your story instead of asking to delete them all.
- Slow thinking models get ten minutes per answer instead of five before Imp gives up on them.
