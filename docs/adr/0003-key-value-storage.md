# 3. Storage is a key-value contract

Date: 2026-11-20 · Status: accepted

## Context

Storage must work the same in a browser and on a server, without native code.

## Decision

Structured state goes through `KeyValueStore`: get, list by prefix, atomic
batch writes and change subscriptions, with JSON values and slash-separated
keys. Media goes to a separate blob store. Queries and indexes are the core's
job, built on prefixes.

## Consequences

- IndexedDB and plain files are both straightforward backends.
- There are no ad-hoc queries; data is laid out by key for the reads it needs.
- This suits one user's projects and would need revisiting for shared, large data.
