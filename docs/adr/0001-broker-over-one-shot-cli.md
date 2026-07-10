# 0001 — Broker process speaking ACP, not one-shot CLI invocations

## Status

Accepted (2026-07-09)

## Context

The plugin needs a runtime layer between Claude Code and Grok Build. Two viable shapes:

1. **One-shot headless invocations** — each job is a background `grok --prompt-file … --output-format streaming-json` process; status by tailing logs, cancel by killing the PID, continuation via `--resume`. Minimal code, but no mid-flight permission routing and crude status/eventing.
2. **Persistent broker** — a companion process holding a `grok agent stdio` connection, mirroring the codex plugin's app-server broker: real job control, streamed updates, interactive permission handling.

Grok Build's stdio mode speaks ACP (Agent Client Protocol), an open JSON-RPC 2.0 standard, so the broker is an ACP client rather than a port of Codex's proprietary app-server protocol.

## Decision

Build the persistent broker from day one, structurally modeled on codex-plugin-cc's broker/job-control architecture, speaking ACP to `grok agent stdio`.

## Consequences

- Feature parity with the codex plugin (status, cancel, result, permission routing) is achievable rather than approximated.
- We take on meaningfully more code than the one-shot approach; the broker lifecycle (spawn, health, teardown) must be managed per session.
- ACP being an open standard means we can lean on existing client libraries and the protocol docs at agentclientprotocol.com instead of reverse-engineering.
- Agent mode forfeits grok's headless-only flags: `--best-of-n`, `--check`, `--max-turns`, and `--allow`/`--deny` are not accepted by `grok agent` (verified against 0.2.93). Turn/runaway limits become the broker's job (ADR 0002); best-of-N and self-check are unavailable unless we later add a one-shot headless escape hatch for those specific modes.
