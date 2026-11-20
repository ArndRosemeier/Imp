# 4. Agents ask before spending or destroying

Date: 2026-11-20 · Status: accepted

## Context

Agents act through the same commands as the user, including ones that cost
money at a provider or remove work.

## Decision

Commands declare an effect: `read`, `write`, `spend` or `destructive`. The
default policy lets the user run anything and lets an agent run `read` and
`write` directly. An agent's `spend` or `destructive` call returns
`needs-approval` without running, and runs once a person approves it. A policy
may also deny, and approval never lifts a denial.

## Consequences

- Every command author must classify the effect honestly; it is reviewed like code.
- The policy is replaceable, so autonomy can become a per-agent setting.
