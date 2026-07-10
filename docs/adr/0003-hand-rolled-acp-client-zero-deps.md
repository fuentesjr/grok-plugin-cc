# 0003 — Plain Node ESM, zero runtime deps, hand-rolled ACP client

## Status

Accepted (2026-07-09)

## Context

Claude Code plugins run directly out of the cloned marketplace repo — no install step, so runtime npm dependencies are unavailable. Options considered for speaking ACP to Grok Build: (1) hand-rolled minimal client, (2) official `@agentclientprotocol/sdk` bundled at build time into a committed artifact, (3) vendoring the SDK source, (4) `npm install` at `/grok:setup` time into the data dir, (5) a Rust/Go broker binary (viable since only macOS is targeted, but forfeits adapting the codex plugin's existing Node lib modules and splits the repo into two runtimes).

## Decision

Match the codex plugin's stack exactly: plain Node ≥18 ESM (`.mjs`), zero runtime dependencies, `node --test`. Hand-roll the ACP client for the narrow surface we consume — `initialize`, `session/new`, `session/prompt`, `session/update`, cancellation. Per ADR 0002 there is no permission-request path. ACP type definitions may be used at dev time only for type-checking.

## Consequences

- The broker port can adapt codex-plugin-cc's proven lib modules (job-control, state, broker-lifecycle) rather than rewrite them.
- We own protocol correctness; mitigated by ACP being a small, stable, documented JSON-RPC 2.0 spec with a reference client in Grok's own docs.
- Upgrade path: if the consumed ACP surface grows meaningfully (session/load, permission requests, richer content blocks), switch to option 2 — the official SDK bundled via esbuild into a committed artifact.
