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

## Build log — slice 1 (2026-07-10)

- Ported the transport-agnostic libs, Grok-branded `render.mjs`, `job-control.mjs`, the minimal slice-2 `grok.mjs` runtime-status stub, and the adapted reference tests.
- Deliberate deviations: `state.test.mjs` clears ambient `CLAUDE_PLUGIN_DATA` for hermetic fallback-state coverage; `grok.mjs` is the requested TODO stub. The legacy `starting codex`/`codex error:` job-control phrases remain unchanged and must stay in lockstep with slice 2's progress wording.
- Verified: `node --test tests/git.test.mjs tests/process.test.mjs tests/render.test.mjs tests/state.test.mjs` — 17 passed, 0 failed.

## Build log — plugin surface (2026-07-10)

Files created (all under `plugins/grok/` unless noted):
- `commands/rescue.md`, `commands/review.md`, `commands/status.md`, `commands/cancel.md`, `commands/result.md`, `commands/setup.md`
- `agents/grok-rescue.md`
- `skills/grok-cli-runtime/SKILL.md`, `skills/grok-result-handling/SKILL.md`
- `prompts/task-brief.md`, `prompts/review.md`
- `schemas/review-output.schema.json` (byte-identical copy of the reference schema)
- `hooks/hooks.json` (SessionStart + SessionEnd only, no Stop hook)
- `LICENSE`, `NOTICE` (byte-identical copies of repo-root files)
- `tests/commands.test.mjs` (self-contained; `tests/helpers.mjs` did not exist at write time, so no dependency on it)

Deviations from the reference:
- Dropped all `gpt-5-4-prompting`-equivalent skill wiring (`grok-rescue` agent has only `skills: [grok-cli-runtime]`) — that skill is explicitly Phase 2 (`grok-prompting`) per `implementation-notes.md`.
- `commands/review.md` drops "native reviewer" framing (reference: "Run a Codex review through the shared built-in reviewer") since Grok has no native reviewer — reworded to "Run a Grok Build review through the grok-companion review runtime." Also dropped the reference's pointer to `/codex:adversarial-review` (no such command in Phase 1).
- `prompts/review.md` adapts the reference `prompts/adversarial-review.md` (the only review-prompt template in the reference) but drops "adversarial" branding/wording per the task brief, since Grok has one review path, not a separate adversarial command — kept the same rigor (skepticism, attack surface, grounding rules) under neutral "software review" framing.
- `commands/setup.md`: dropped the reference's `--enable-review-gate|--disable-review-gate` argument-hint and toggle guidance (Phase 1 has no Stop hook / review gate). Replaced the reference's `npm install -g @openai/codex` install step with grok's actual installer (`curl -fsSL https://x.ai/cli/install.sh | bash`, from `~/.grok/docs/user-guide/01-getting-started.md`) since the npm path is factually wrong for Grok — same AskUserQuestion idiom, corrected command.
- `commands/status.md` description drops "including review-gate status" (Phase 2 feature, not present).
- Model alias is `fast` → `grok-composer-2.5-fast` everywhere (never `spark`), per the task brief.
- `hooks/hooks.json` has no `Stop` entry and no `stop-review-gate-hook.mjs` reference, matching the Phase 1 scope in `docs/porting-map.md`.
- `tests/commands.test.mjs` is a from-scratch adaptation of the reference test file (which asserts on `adversarial-review.md`/`transfer.md`, absent here) rather than a line-by-line port; it asserts the Phase 1 command set, frontmatter, verbatim-output rules, trust-but-verify/failure-policy language in `grok-result-handling`, and the hooks/schema/LICENSE shape instead.

Verification:
- `node --test tests/commands.test.mjs` — 11 passed, 0 failed.
- `node --test tests/*.test.mjs` (full suite, includes the parallel worker's lib tests) — 28 passed, 0 failed, no conflicts.
- `diff` confirmed `schemas/review-output.schema.json`, `LICENSE`, and `NOTICE` are byte-identical to their source-of-truth copies.

Open questions / residual risk:
- `commands/setup.md`'s install-offer step (`curl -fsSL https://x.ai/cli/install.sh | bash`) is unverified against the actual `grok-companion.mjs setup` output shape (that script doesn't exist yet in my scope) — the wording assumes an "unavailable" signal shaped like the reference's; worth a re-check once `scripts/grok-companion.mjs setup` lands.
- `prompts/review.md` and `prompts/task-brief.md` are static templates; nothing in my scope wires `{{PLACEHOLDER}}` interpolation — that's `scripts/lib/prompts.mjs`'s job (owned elsewhere per the porting map's "Verbatim ports" list).

## Build log — slice 2 ACP runtime core (2026-07-10)

- Added the fake Grok ACP fixture, direct/broker ACP client, rename-only broker lifecycle, ACP-backed `grok.mjs`, persisted task-session state, and runtime-core tests.

| ACP event | Progress phrase | Phase |
|---|---|---|
| `agent_message_chunk` | buffered; `Assistant message captured: …` when `session/prompt` resolves | `finalizing` |
| `agent_thought_chunk` | `Reasoning: …` | `investigating` |
| command-like `tool_call` | `Running command: …` | `verifying` or `investigating` |
| other `tool_call` | `Running tool: …` | `investigating` |
| `tool_call_update` | `Command/Tool completed: …` or `… failed: …` | tool-dependent or `failed` |
| `plan` | `Plan updated: …` | `planning` (`job-control` presents it as `investigating`) |
| `session/prompt` result | `Turn completed (<stopReason>).` or `Turn cancelled.` | `finalizing` or `cancelled` |

- Resume strategy: persist `{id, name, finalMessage, updatedAt}` as `lastTaskSession` in the per-workspace `state.json`; `--resume-last` creates a fresh ACP session seeded with the prior session ID, prior final message, and `DEFAULT_CONTINUE_PROMPT`. No unverified `session/load` call is used.
- Lockstep wording: `job-control.mjs` now recognizes `Starting Grok …`, `Session ready`, reasoning/plan/tool phrases, `Grok error`, budget cancellation, and ACP log-block titles. Rendered resume hints now use `/grok:rescue --resume <follow-up request>` instead of claiming direct CLI session resume.
- ACP deviations: ACP exposes no verified turn ID, so `turnId` remains `null`; cross-process `cancelAcpTurn` requires the shared broker, while direct client budget cancellation uses the active connection. Review schema enforcement is prompt-driven by embedding the schema because ACP has no output-schema parameter. Broker-socket end-to-end tests remain for slice 3; direct spawn and busy-to-direct mechanics are implemented now.
- Verified: `npm test` — 41 passed, 0 failed.

## Build log — slice 3 final runtime (2026-07-10)

- Added `acp-broker.mjs`, `grok-companion.mjs`, `session-lifecycle-hook.mjs`, and Phase-1 end-to-end runtime coverage. The companion implements setup/review/task/background-worker/resume-candidate/status/result/cancel, the clean-tree write guard, detached workers, tracked logs/results, and Phase-1-only setup/status rendering.
- Broker routing declaration: broker-bound `session/new` adds private `_meta.grokCompanion = { access: "read-only"|"workspace", budgetMs? }`; the broker removes that field before forwarding, independently injects standing `_meta.rules`, eagerly owns one `read-only` child, lazily owns one `workspace` child, and records `sessionId → child`. Default/invalid access is read-only.
- Protocol decisions: the broker terminates client `initialize` locally, globally busy-locks requests with code `-32001`, always admits notification-only `session/cancel`, retains prompt ownership after client disconnect, enforces the optional session budget with `session/cancel`, removes mappings when a child dies, and respawns that profile on its next `session/new`. `GROK_COMPANION_RUNTIME_DIR` optionally relocates short-lived broker socket state for hermetic hosts; queued requests are persisted before detached spawn and `state.json` uses atomic replacement to avoid parent/worker races.
- Verification: `node --test tests/*.test.mjs` — 61 tests total, 57 passed, 0 failed, 4 skipped. This execution sandbox rejects all `net.Server.listen()` calls with `EPERM`; the four Unix-socket broker/lifecycle cases are capability-gated and run on hosts that permit local sockets. All remaining CLI, fake-Grok, foreground/background, cancel, budget, write-guard, review, resume, and non-socket lifecycle paths passed.

## Build log — budget and ownership fixes (2026-07-10)

- Root causes: `session/prompt` inherited the 120-second request timeout despite being a turn-lifetime request; task/review dispatch had no default wall budget; broker socket teardown did not release its busy lock or cancel owned work; cancellation trusted only a session ID; direct Grok children shared teardown assumptions that did not survive a killed detached worker.
- Fixes: prompt requests now wait without a transport timeout while handshake/session creation retain bounded waits. Every task/review gets a 20-minute budget unless `--budget-ms` or `GROK_COMPANION_BUDGET_MS` overrides it; broker routing always declares the effective budget and the broker independently defaults/arms its backstop. Disconnect releases request/stream ownership, cancels that socket's in-flight sessions, and suppresses orphan notifications; cross-socket cancellation is dropped.
- Orphan hygiene: broker-owned work is cancelled when its owning socket disappears. Direct Grok is a separate process-group leader, `close()` terminates that group, and active direct-child PIDs are persisted so cancel/session teardown can sweep the child group even after its worker dies.
- Minor cleanup: removed the unused `requiresOpenaiAuth` setup-auth field.
- Verified: `node --test tests/*.test.mjs` — 63 tests total, 59 passed, 0 failed, 4 skipped. The skipped cases require Unix sockets, which this execution sandbox blocks; the broker ownership/disconnect regressions are included and capability-gated.
