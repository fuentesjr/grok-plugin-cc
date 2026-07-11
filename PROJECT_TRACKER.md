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
- [x] Install as local marketplace in Claude Code and exercise the commands from a session (Sal, 2026-07-10, session 46e89803 in ~/Projects/ctxpack: setup ready + version persisted, rescue via grok-rescue subagent completed read-only, status/result round-trip, hook-exported session id confirmed in job records)
- [x] Live background **write** job (task-mrfm0omk-ryt237 in ~/Projects/ctxpack): completed end_turn, edited README.md in place, standing no-commit rule honored by the model. Known issue found: `touchedFiles` came back empty despite a real edit — session/update file-change decoding gap, fixed in 2ec4bc4 (verified live: real write job now reports the edited path).

**Phase 1 is fully signed off (2026-07-10).**
- [x] Update `implementation-notes.md` verification status

## Phase 2 — Parity

- [x] Design grilling — decisions recorded in `implementation-notes.md` "Phase 2 design" (2026-07-10; Fable advised the adversarial prompt)

All three slices built, committed (c1dbad6 slices 1+2, 6790912 slice 3), reviewer/doc-reviewer-gated, and live-verified against grok 0.2.93. 91/91 hermetic on host. Build order was review split → stop-gate → grok-prompting; codex did the runtime-coupled code (dispatched **fresh** each time — `--resume-last` fails in this repo, prior porting session ran under the pre-rename path), self owned all markdown/research/integration/verification, Fable advised the adversarial prompt + the stop-gate busy/parsing calls.

### Next steps

Phase 2 is **code-complete** and its **behavioral layer is an automated green smoke**: `scripts/phase2-live-smoke.sh` drives the real `grok` CLI through the companion + Stop hook (review catches a planted bug, adversarial-review returns design findings, setup gate toggle, and the Stop hook's ALLOW/BLOCK/busy-skip/gate-off matrix) — last run 15/15 green, 2026-07-11. What remains before calling the plugin fully done:

1. **In-TUI harness validation (reserved for Sal — the only part the smoke script cannot cover).** The smoke proves the behavior; it cannot prove the Claude Code *harness* wiring.
   - [x] `/grok:adversarial-review` registered as a live slash command — confirmed in-session via `/grok` autocomplete (2026-07-11).
   - [ ] `Stop` hook fires on a genuine Stop event and honors the block decision — the last unconfirmed item. In a real session (restart the workspace broker first — kill pid + remove `broker.json` — so it loads current code): `/grok:setup --enable-review-gate`, make a buggy edit, end the turn → confirm the gate BLOCKS the stop; a clean edit → ALLOW; then `/grok:setup --disable-review-gate`.
   - (`scripts/phase2-live-smoke.sh` covers all the behavior end-to-end; run it for the behavioral regression pass.)
2. **After #1, mark Phase 2 fully signed off** and update this tracker + `implementation-notes.md` verification log with the session id (mirrors the Phase-1 sign-off entry, session 46e89803).
3. Optional / deferred by design: worktree isolation for background write jobs — only if the clean-tree guard ever chafes (it hasn't).

**Runtime gotcha (still applies):** after changing plugin code, restart the broker (kill pid + remove `broker.json` from the state dir) or live runs exercise stale code.
**Dispatch gotcha:** codex `--resume-last` does not resolve in this repo — dispatch codex **fresh** with a self-contained spec-brief for any future runtime-coupled work.

### Stop-review-gate — DONE (2026-07-11)
- [x] `scripts/stop-review-gate-hook.mjs` — `Stop` hook: turn-scoped internal `stop-review-task --json`, `ALLOW:`/`BLOCK:` parse; skip+allow when broker busy (pre-check + structured `-32001`); nested budget/timeout (8m/10m/12m); fail-closed on genuine review failure, fail-open on not-set-up + busy. codex built it; Fable vetted the runtime coupling. Reviewer-approved after two should-fixes (queued-path liveness guard, null-pid tests).
- [x] `prompts/stop-review-gate.md` (rebranded, turn-scoped, hardened verdict contract) + `Stop` entry in `hooks/hooks.json` (720s)
- [x] `config.stopReviewGate` default off + `/grok:setup --enable-review-gate|--disable-review-gate` (toggle re-added to `setup.md` + companion `handleSetup`; setup report surfaces gate status)
- **Live-exposed fix:** real grok prepends a preamble before the verdict token (breaks the strict first-line parse → permanent stop-loop). Added a boundary-guarded tier-2 verdict scan (Fable-advised); ambiguity/no-token still fail closed. Live-verified ALLOW/BLOCK/busy-skip + setup toggle.

### Review split (Option A) — DONE (2026-07-11)
- [x] Re-scope `/grok:review` prompt to defect/correctness (bug-hunt); re-verify with the planted-bug case — **live-verified**: re-scoped review caught a planted overdraft bug (removed sufficient-funds guard) as `needs-attention`, critical, confidence 0.99, schema-valid. No lost teeth.
- [x] `/grok:adversarial-review` command + companion `adversarial-review` subcommand (accepts focus text) + `prompts/adversarial-review.md` (Fable spec: `design_attack_surface`, burden-of-proof, named-alternative-with-costs, steelman-then-break, undefended-commitment, anchor rule, confidence ≤0.6 on inference). codex did the runtime coupling (`runAcpReview` `promptName`) + companion subcommand + tests. Reviewer-approved (should-fix: added an adversarial-template-selection assertion; nit: rendered label now "Adversarial Review"). **Live-verified**: adversarial run on a symptom-patch diff produced grounded design findings (undefended-commitment + wrong-layer) with named alternatives + costs, focus honored, schema-valid.

### grok-prompting skill — DONE (2026-07-11)
- [x] `skills/grok-prompting/` — research-first, thin (SKILL.md + 1 reference), honestly-attributed. Part 1 = xAI-official (from docs.x.ai grok-code-prompt-engineering, build/overview, prompt-caching best-practices), Part 2 = clearly-labeled generic craft NOT attributed to xAI; zero GPT/codex/OpenAI content. Honest caveat: Grok Build defaults to grok-4.5 while xAI's prompt guide targets grok-code-fast-1 (structural points are model-general, model-selection point is not). Wired into `grok-rescue` agent `skills` (after `grok-cli-runtime`). doc-reviewer independently corroborated all four sources — attribution accurate, no corrections. Forward-note: re-verify Part 1 citations if grok-code-fast-1's xAI docs page is ever pulled.

### Verification & sign-off
- [x] Hermetic suite green (`node --test`) incl. new stop-gate + adversarial-review + review-split + grok-prompting tests — 91/91 on host (0 skipped), 2026-07-11
- [x] Live: gate ALLOW/BLOCK round-trip, busy-broker skip, `/grok:adversarial-review` on a planted design-smell diff, re-scoped `/grok:review` still catches the planted bug — all live-verified against grok 0.2.93, 2026-07-11

**Phase 2 is fully signed off (2026-07-11):** all three slices landed, reviewer/doc-reviewer-gated, live-verified. Fable advised the adversarial prompt + the stop-gate busy/parsing decisions.
