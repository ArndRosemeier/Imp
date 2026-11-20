# 1. One command layer for people and agents

Date: 2026-11-20 · Status: accepted

## Context

Everything a person can do in Imp, an LLM agent must be able to do as well.
Building the UI first and adding agent access afterwards would let the two
drift apart with every feature.

## Decision

Every capability is declared once as a command with a Zod input and output
schema, a description and an effect level. The UI, agents and outside callers
execute commands through one registry. The UI gets no other access to state.

## Consequences

- Agent parity is structural and is checked by a test that walks the registry.
- Descriptions and schemas are part of the product, since models read them.
- UI code that would be quicker with direct state access is not allowed to have it.
