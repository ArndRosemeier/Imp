# 5. Agents spend context sparingly

Date: 2026-11-20 · Status: accepted

## Context

Every command is a tool an agent can call. Sent naively, that costs context
on every request: all tool definitions, every list in full, and the whole
conversation with every earlier tool result. It grows with each mode and each
turn, and the user pays for it in money and in the model's attention.

## Decision

Four rules, all inside the existing command layer:

1. **Lists are outlines.** A list command returns ids and short fields. Long
   fields come from a `get` for one item, or from the list's `full` flag, which
   the UI uses and agents are told to avoid.
2. **Stable prefixes are cached.** The instructions hold nothing that changes
   between requests; the context of a run travels with the user's message. The
   runner marks the instructions and the newest message as cache points, and
   the provider adapter turns the marks into what its API understands.
3. **A wide scope is looked up, not carried.** A role may name the commands it
   gets as tools from the start (`direct`). The rest of its scope is reached
   with two fixed tools, `find_commands` and `run_command`, which go through
   the same scope check, policy and activity log.
4. **Used results are dropped.** When a run ends, long tool results are
   replaced by a note in the conversation that is handed back. The agent reads
   again when it needs to; what ran stays in the activity log.

## Consequences

- A new mode costs the coordinator one line of instructions, not its tools.
- Command authors must write a `get` beside every list with long fields.
- Measured on 2026-11-20 with a small Anthropic and a small OpenAI model: 65
  to 93 percent of prompt tokens were read from cache over three-to-five-step
  runs.
- Tool call arguments (for example a scene the model wrote) still stay in the
  conversation; trimming those is open.
