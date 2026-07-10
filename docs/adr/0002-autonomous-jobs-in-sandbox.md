# 0002 — Jobs run autonomously inside a sandbox, no interactive approvals

## Status

Accepted (2026-07-09; revised 2026-07-09 after ACP sandbox spike)

## Context

ACP supports interactive permission requests: the agent can ask the client to approve each tool execution. The alternative is autonomous execution with safety enforced by Grok Build's OS-level sandbox profiles. The dispatching user is typically not watching the job run, so approval prompts would stall background work indefinitely. This is also the codex plugin's proven policy (`sandbox: read-only` default, `workspace-write` on request).

A spike against grok 0.2.93 (live ACP write-probes, workdir outside temp dirs) established how sandboxing actually binds in agent mode:

- The sandbox profile binds **at process spawn** (`grok --sandbox <profile> agent stdio`) and is kernel-enforced there — under `read-only`, every write path (edit tool, shell redirect, python) fails with `Operation not permitted`.
- `session/new`'s `_meta.agentProfile` **cannot** restrict a session: `sandbox` and `capability_mode` fields in a profile object are silently ignored (a write-probe under a `read-only` profile succeeded), and a malformed profile does not fail the request — it logs an error and silently falls back to the default agent.
- `grok agent` accepts none of the headless guardrail flags: no `--allow`/`--deny`, no `--max-turns`.

So per-job sandbox switching over a single persistent child is impossible; the profile is a property of the child process.

## Decision

The broker launches `grok agent stdio` children with auto-approval; ACP permission requests never fire. Safety comes from per-**child** sandbox profiles: the broker manages up to two children — a `read-only` child (spawned at broker start, the default for all jobs) and a `workspace` child (spawned lazily on the first job that requests write access). Each job's ACP session is created on the child whose profile matches the job's access level. Write jobs run in place in the project working tree, not in a worktree, matching the codex plugin.

Because agent mode has no `--deny` or `--max-turns`, the broker owns the guardrails those flags provided in headless mode:

- **Runaway guard**: every job gets a wall-clock budget; on expiry the broker sends `session/cancel` (verified honored mid-turn, `stopReason: cancelled`) and marks the job failed.
- **Standing rules**: every `session/new` injects `_meta.rules` forbidding `git commit`/`git push` and work outside the workspace. This is prompt-level guidance, not enforcement — the sandbox is the only hard boundary.
- **Shared-tree guard**: a background write job and the live Claude Code session would otherwise edit the same tree unsupervised, so background+write dispatch requires a clean working tree; otherwise the command tells the user to commit/stash or run with `--wait`. (Worktree isolation is the Phase 2 upgrade if this chafes.)

## Consequences

- Jobs never block on a human; status/cancel are the only mid-flight controls.
- Sandbox enforcement is the actual security boundary. Known gap: grok's child-process network blocking under `read-only`/`strict` is a no-op on macOS, so read-only jobs there are filesystem-confined but not network-confined.
- The ACP client stays simpler (no permission-request handling path).
- Broker lifecycle manages up to two children instead of one; the workspace child's cost is only paid when a write job is dispatched.
- `_meta.agentProfile` must never be relied on for restriction, and its silent-fallback failure mode means the broker should treat profiles as prompt-shaping only.
