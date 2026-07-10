# Project Tracker

Working checklist for building the plugin. Decisions live in `implementation-notes.md` and `docs/adr/`; this file only tracks execution. Reference implementation: `~/.claude/plugins/marketplaces/openai-codex/`.

## Phase 0 — Bootstrap

- [x] `git init`, first commit of docs (CONTEXT.md, ADRs, notes, this tracker)
- [x] Repo skeleton: root `package.json` (Node ≥18, `node --test`), `LICENSE` (Apache-2.0), `NOTICE` crediting openai/codex-plugin-cc
- [x] `.claude-plugin/marketplace.json` → `plugins/grok/.claude-plugin/plugin.json`

## Phase 1 — Core loop

### Runtime (TDD against the fixture)

- [x] `tests/fake-grok-fixture.mjs` — stub ACP server over stdio: completing turn, streaming turn, hanging turn (for cancel)
- [x] `scripts/lib/acp-client.mjs` — hand-rolled ACP client: initialize, session/new (with `_meta` rules), session/prompt, session/update handling, cancel
- [x] Port/adapt codex lib modules: `state.mjs`, `broker-endpoint.mjs`, `broker-lifecycle.mjs`, `job-control.mjs`, `tracked-jobs.mjs`, `process.mjs`, `workspace.mjs`, `git.mjs`, `render.mjs`, `args.mjs`, `fs.mjs`, `prompts.mjs` — note `render.mjs`/`job-control.mjs` are rewrites against ACP `session/update` events, not adaptations (plus `grok.mjs`, the `codex.mjs` analog)
- [x] `scripts/grok-companion.mjs` — CLI entry the commands invoke (lives at `plugins/grok/scripts/`, mirroring the reference)
- [x] `scripts/acp-broker.mjs` — broker daemon: unix socket; sandbox binds at spawn, so up to two children via `grok --sandbox <profile> agent --no-leader --always-approve stdio` — `read-only` at start, `workspace` lazily on first write job; route each job's session to the matching child (ADR 0002)
- [x] Broker guardrails: per-job wall-clock budget (default 20m, always armed) → `session/cancel` on expiry; standing `_meta.rules` (no `git commit`/`push`) on every `session/new`; clean-tree check before background write jobs
- [x] `scripts/session-lifecycle-hook.mjs` + `hooks/hooks.json` (SessionStart/SessionEnd only; no Stop hook yet)

### Plugin surface

- [x] `commands/rescue.md` (`--background|--wait`, `--resume|--fresh`, `--model` with `fast` alias, `--effort`)
- [x] `commands/review.md` + `schemas/review-output.schema.json` (mirror codex shape) + `prompts/` (incl. task-brief template: context, task, constraints, acceptance criteria, verification command); review findings feed `ReportFindings`
- [x] `commands/status.md`, `commands/cancel.md`, `commands/result.md`
- [x] `commands/setup.md` — install/auth/ACP-handshake smoke check
- [x] `agents/grok-rescue.md`
- [x] `skills/grok-cli-runtime/SKILL.md`, `skills/grok-result-handling/SKILL.md` (result handling encodes trust-but-verify + failure policy from `implementation-notes.md`)

### Verification & sign-off

Pre-verified by live ACP spike (2026-07-09): process-level sandbox enforcement, `session/cancel` mid-turn, `_meta.agentProfile` non-enforcement — see `implementation-notes.md`.

- [x] Hermetic suite green (`node --test`) — 63/63 including socket-gated broker tests (2026-07-10)
- [x] `/grok:setup` passes against real `grok` 0.2.93 (companion `setup --json`: ready, auth verified via live ACP handshake)
- [x] Manual end-to-end: real `/grok:rescue` (read-only) and `/grok:review` on a sample diff; `/grok:status`/`/grok:result` round-trip; cancel a hanging job; write job blocked on dirty tree when backgrounded — all via companion CLI (2026-07-10; found and fixed the session/prompt flat-timeout bug in the process)
- [ ] Install as local marketplace in Claude Code and exercise the commands from a session (reserved for Sal)
- [x] Update `implementation-notes.md` verification status

## Phase 2 — Parity (grill before starting)

- [ ] Design grilling for transfer semantics and stop-review-gate behavior
- [ ] `/grok:transfer` — Claude→Grok session hand-off (riskiest piece)
- [ ] `/grok:adversarial-review` + stop-review-gate Stop hook
- [ ] `skills/grok-prompting/` — sourced strictly from xAI's official guidance
