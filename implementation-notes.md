# Implementation notes

Decisions from the 2026-07-09 design grilling, revised same day after a design review + live ACP spike against grok 0.2.93. ADRs in `docs/adr/` hold the reversible-with-pain decisions; this file holds the rest.

## What this is

A Claude Code plugin that delegates work to Grok Build (xAI's `grok` CLI), a faithful structural port of `openai/codex-plugin-cc` so the two feel interchangeable. Reference checkout: `~/.claude/plugins/marketplaces/openai-codex/`.

## Locked decisions

- **Runtime**: persistent per-cwd broker speaking ACP (JSON-RPC 2.0) to private `grok agent --no-leader stdio` children. Not Grok's shared leader; not one-shot CLI calls. (ADR 0001)
- **Permissions**: no interactive approvals; children launched with `--always-approve`. Sandbox binds at child spawn, so the broker runs up to two children: `read-only` (default, spawned at start) and `workspace` (lazy, on first write job). Write jobs run in place; background+write requires a clean working tree. (ADR 0002, revised)
- **Broker-owned guardrails** (agent mode has no `--deny`/`--max-turns`): per-job wall-clock budget enforced via `session/cancel`; standing `_meta.rules` on every session forbidding `git commit`/`git push` (prompt-level only — the sandbox is the hard boundary). (ADR 0002)
- **Stack**: plain Node ≥18 ESM `.mjs`, zero runtime deps, hand-rolled ACP client (~5 methods). Upgrade path: bundled `@agentclientprotocol/sdk` if the surface grows. (ADR 0003)
- **Layout/naming**: marketplace repo mirroring codex — `.claude-plugin/marketplace.json` → `plugins/grok/`. Commands `/grok:*`, agent `grok-rescue`, env/state `GROK_COMPANION_*`, state keyed by cwd.
- **Models**: never pinned; inherit grok's configured default. `--model`/`--effort` passthrough; alias `fast` → `grok-composer-2.5-fast`.
- **License**: Apache-2.0 with NOTICE crediting openai/codex-plugin-cc (we adapt its lib modules directly).
- **Testing**: hermetic `node --test` against a `fake-grok-fixture.mjs` speaking minimal ACP (complete turn, streaming turn, hanging turn for cancel). TDD the ACP client and job control against it. Real-CLI smoke check lives in `/grok:setup`; real end-to-end dispatch verified manually before phase sign-off.
- **Port caveat**: `render.mjs` and `job-control.mjs` are coupled to codex's app-server event vocabulary; expect rewrites-with-reference against ACP's `session/update` types, not adaptations.

## Dispatch & result conventions (adopted from grok-agent-DESIGN.md)

- **Task briefs are specs, not vibes.** Every rescue brief carries: context (relevant files/conventions), the task, constraints (don't touch X, follow pattern Y), acceptance criteria, and the exact verification command. Template lives in `prompts/`.
- **Trust but verify.** Claude re-runs the verification command itself after a write job; Grok's claim of green is never sufficient. Review findings are candidates, not conclusions — Claude checks each against the code before surfacing it.
- **Result reports always state**: what Grok changed (diff summary), what Claude verified itself, and anything skipped or unverified.
- **`/grok:review` findings feed Claude Code's `ReportFindings` tool** so they render as first-class review findings.

## Failure handling

- `grok` errors or the stream is malformed → report the raw tail of the job log; retry once (resuming the session) only if the failure looks transient.
- Grok claims success but verification fails → one feedback round on the same session with the failing output; if the second attempt also fails, stop and report — Claude fixes the residue itself or hands the diff back to the user.
- Job budget expiry → broker sends `session/cancel`, marks the job failed, preserves the log.
- Auth expired → `/grok:setup` re-checks the handshake and points the user at `grok login`.

## Phases

**Phase 1 (core loop):** broker + ACP client, `/grok:rescue`, `/grok:review`, `/grok:status`, `/grok:cancel`, `/grok:result`, `/grok:setup`, `grok-rescue` agent, `grok-cli-runtime` + `grok-result-handling` skills, session-lifecycle hooks, review output schema (reuse codex's `review-output.schema.json` shape).

**Phase 2:** `/grok:transfer` (Claude→Grok session hand-off — riskiest piece), `/grok:adversarial-review`, stop-review-gate hook, `grok-prompting` skill (base strictly on xAI's official docs.x.ai guidance; keep short), worktree isolation for background write jobs if the clean-tree guard chafes.

Phase 2 details deliberately un-grilled — grill them when Phase 1 ships.

## Environment facts (as of 2026-07-09)

- `grok` 0.2.93 at `~/.grok/bin/grok`, logged in via grok.com, default model `grok-4.5`.
- `grok agent stdio` speaks ACP; docs in `~/.grok/docs/user-guide/15-agent-mode.md`; `session/new` `_meta` supports `rules`, `systemPromptOverride`, `agentProfile`.
- Sandbox profiles: off, workspace, devbox, read-only, strict. Child network blocking is a no-op on macOS (accepted gap, ADR 0002).
- Only macOS is targeted/supported.

### Verified by live ACP spike (2026-07-09)

- `--sandbox` is a global flag only; `grok agent stdio --sandbox` is rejected. Spawn as `grok --sandbox <profile> agent --no-leader --always-approve stdio`.
- Process-level `read-only` sandbox is kernel-enforced in agent mode (all write paths → `Operation not permitted`; probe must run outside temp dirs, which `read-only` permits writes to).
- `_meta.agentProfile` requires `name`, `description`, `prompt`; `sandbox`/`capability_mode` fields are silently ignored (write-probe succeeded under a "read-only" profile). A malformed profile does not fail `session/new` — it silently falls back to the default agent. Treat profiles as prompt-shaping only.
- `session/cancel` is honored mid-turn: prompt resolves with `stopReason: "cancelled"` (`cancellationCategory: MidTurnAbort`).
- `grok agent` accepts none of the headless-only flags: `--allow`/`--deny`, `--max-turns`, `--best-of-n`, `--check` are unavailable over ACP (ADR 0001).
- `--debug-file` logs include the OAuth bearer token in plaintext — never enable it in shipped code paths; scrub any spike logs.

## Open items

- Verification status: nothing implemented yet; spike findings above are the only verified behavior.
