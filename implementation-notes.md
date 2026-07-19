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

**Phase 2:** `/grok:adversarial-review`, stop-review-gate hook, `grok-prompting` skill (base strictly on xAI's official docs.x.ai guidance; keep short), worktree isolation for background write jobs if the clean-tree guard chafes.

Phase 2 details deliberately un-grilled — grill them when Phase 1 ships.

**Cut features:** `/grok:transfer` cut 2026-07-10: codex's session import relies on a codex-specific RPC with no verified ACP equivalent; risk/value didn't justify it.

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

- **Phase 2 live in-session validation (reserved for Sal):** everything is verified via the companion CLI + hermetic tests + real hook-JSON piped to the Stop hook, but the Phase-2 surface has not been exercised through an actual marketplace install in a live Claude Code session — `/grok:adversarial-review` as a real slash command, the Stop gate firing on a genuine Stop event with the gate enabled (confirms hooks.json registration + the 720s ceiling + the harness honoring `{decision:"block"}`), and `/grok:setup --enable-review-gate` from within a session. This mirrors the Phase-1 live-session sign-off. See PROJECT_TRACKER "Next steps".
- Deferred by design (not needed): worktree isolation for background write jobs — listed as optional "if the clean-tree guard chafes"; it never chafed.
- Known accepted debt from the 2026-07-10 runtime review: unix-socket perms rely on the 0700 mkdtemp dir (matches reference; fine on macOS per-user TMPDIR); jobs dispatched without `GROK_COMPANION_SESSION_ID` are not swept by SessionEnd cleanup (edge case — the hook always sets it in real installs).
- Operational gotcha: the broker daemon persists per session and holds loaded code — after upgrading plugin code, restart the broker (SessionEnd or kill + remove `broker.json`) or jobs keep hitting the old behavior.

## Verification status (2026-07-11, Phase 2 — SIGNED OFF)

- Hermetic: `node --test tests/*.test.mjs` — **91/91** on host (0 skipped; sockets available).
- Behavioral smoke: `scripts/phase2-live-smoke.sh` against real grok 0.2.93 — **15/15** (review catches planted bug, adversarial-review returns design findings, setup gate toggle, Stop hook ALLOW/BLOCK/busy-skip/gate-off).
- In-harness (live Claude Code session 57c0e7a5, plugin 0.2.0): `/grok:adversarial-review` registered as a slash command ✓; Stop hook fired on a genuine Stop event, reviewed the turn, and the harness **honored the block** on a planted no-base-case `factorial` (session did not end; reason clean, no preamble leak) ✓; gate toggle + disable ✓.
- Install mechanics learned: the harness runs the *installed* plugin snapshot, not the live repo; version bumps are required for `/plugin` update to refresh (0.1.0→0.1.0 no-ops). Bumped to 0.2.0; `/reload-plugins` re-registers hooks live without a full restart.

## Verification status (2026-07-10, Phase 1)

- Hermetic: `node --test tests/*.test.mjs` — **63/63** on macOS (codex's build sandbox skips 4 socket-gated broker tests; they pass on the host).
- Live against `grok` 0.2.93: setup/auth via real ACP handshake ✓; read-only rescue ✓; prompt-driven review on a planted-bug diff returned schema-valid JSON with the bug found (`parseError: null`) ✓; background job ran past 120s after the flat-timeout fix ✓; mid-turn cancel honored (`turnInterrupted: true`) ✓; status/result round-trips ✓; dirty-tree refusal for background+write ✓; no orphaned grok processes after cancel ✓.

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

- Resume strategy: persist `{id, name, finalMessage, updatedAt}` as `lastTaskSession` in the per-workspace `state.json`. `--resume-last` prefers native ACP `session/load` when the agent advertises `loadSession` and the thread still exists (verified against real grok: cross-process load retains conversation history). Falls back to a seeded `session/new` + prior-final-message prompt when load is unsupported or the thread is gone.
- Lockstep wording: `job-control.mjs` now recognizes `Starting Grok …`, `Session ready`, reasoning/plan/tool phrases, `Grok error`, budget cancellation, and ACP log-block titles. Rendered resume hints now use `/grok:rescue --resume <follow-up request>` instead of claiming direct CLI session resume.
- ACP deviations: ACP exposes no verified turn ID, so `turnId` remains `null`; cross-process `cancelAcpTurn` requires the shared broker, while direct client budget cancellation uses the active connection. Review schema enforcement is prompt-driven by embedding the schema because ACP has no output-schema parameter. Broker-socket end-to-end tests remain for slice 3; direct spawn and busy-to-direct mechanics are implemented now.
- Verified: `npm test` — 41 passed, 0 failed.

## Build log — slice 3 final runtime (2026-07-10)

- Added `acp-broker.mjs`, `grok-companion.mjs`, `session-lifecycle-hook.mjs`, and Phase-1 end-to-end runtime coverage. The companion implements setup/review/task/background-worker/resume-candidate/status/result/cancel, the clean-tree write guard, detached workers, tracked logs/results, and Phase-1-only setup/status rendering.
- Broker routing declaration: broker-bound `session/new` adds private `_meta.grokCompanion = { access: "read-only"|"workspace", budgetMs? }`; the broker removes that field before forwarding, independently injects standing `_meta.rules`, eagerly owns one `read-only` child, lazily owns one `workspace` child, and records `sessionId → child`. Default/invalid access is read-only.
- Protocol decisions: the broker terminates client `initialize` locally, globally busy-locks requests with code `-32001`, always admits notification-only `session/cancel`, retains prompt ownership after client disconnect, enforces the optional session budget with `session/cancel`, removes mappings when a child dies, and respawns that profile on its next `session/new`. `GROK_COMPANION_RUNTIME_DIR` optionally relocates short-lived broker socket state for hermetic hosts; queued requests are persisted before detached spawn and `state.json` uses atomic replacement to avoid parent/worker races.
- Verification: `node --test tests/*.test.mjs` — 61 tests total, 57 passed, 0 failed, 4 skipped. This execution sandbox rejects all `net.Server.listen()` calls with `EPERM`; the four Unix-socket broker/lifecycle cases are capability-gated and run on hosts that permit local sockets. All remaining CLI, fake-Grok, foreground/background, cancel, budget, write-guard, review, resume, and non-socket lifecycle paths passed.

## Build log — issue #3 status --wait timeout (2026-07-14)

- Root cause: `DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000` was shorter than the 20m job budget, so default `status --wait` threw exit 1 while healthy jobs still ran.
- Fix (best path): default wait uses an absolute **job budget deadline** (`startedAt + budgetMs + grace`), re-resolved each poll so queued→running re-anchors; explicit `--timeout-ms` is a fixed window from wait start. Wait timeout returns the still-active job snapshot and exits 2 (`STATUS_WAIT_TIMEOUT_EXIT_CODE`) with clear "not a job failure" wording.
- Queued jobs without `startedAt` get a full allowance from "now" so queue time does not steal the productive wait window.

## Build log — issues #1 and #2 (2026-07-14)

- **#2 resume**: `runAcpTurn` tries ACP `session/load` when `resumeThreadId` is set and the agent advertises `loadSession` (real grok: true; broker now advertises true and routes `session/load` like `session/new`). Same thread ID, plain continue prompt. On load failure or `loadSession: false`, falls back to seeded `session/new` + prior-final-message prompt.
- **#1 budget**: productive budget still cancels mid-turn; a default 90s grace turn then sends `BUDGET_GRACE_PROMPT` so expiry can leave a handoff. Broker routing budget is `budgetMs + budgetGraceMs` so the backstop does not kill wind-down. Companion usage documents `--budget-ms` and the 20m default.
- Verified: `node --test tests/*.test.mjs` (load/resume paths, grace handoff, prior suite).

## Build log — budget and ownership fixes (2026-07-10)

- Root causes: `session/prompt` inherited the 120-second request timeout despite being a turn-lifetime request; task/review dispatch had no default wall budget; broker socket teardown did not release its busy lock or cancel owned work; cancellation trusted only a session ID; direct Grok children shared teardown assumptions that did not survive a killed detached worker.
- Fixes: prompt requests now wait without a transport timeout while handshake/session creation retain bounded waits. Every task/review gets a 20-minute budget unless `--budget-ms` or `GROK_COMPANION_BUDGET_MS` overrides it; broker routing always declares the effective budget and the broker independently defaults/arms its backstop. Disconnect releases request/stream ownership, cancels that socket's in-flight sessions, and suppresses orphan notifications; cross-socket cancellation is dropped.
- Orphan hygiene: broker-owned work is cancelled when its owning socket disappears. Direct Grok is a separate process-group leader, `close()` terminates that group, and active direct-child PIDs are persisted so cancel/session teardown can sweep the child group even after its worker dies.
- Minor cleanup: removed the unused `requiresOpenaiAuth` setup-auth field.
- Verified: `node --test tests/*.test.mjs` — 63 tests total, 59 passed, 0 failed, 4 skipped. The skipped cases require Unix sockets, which this execution sandbox blocks; the broker ownership/disconnect regressions are included and capability-gated.

## Build log — setup version drift (2026-07-10)

- Successful setup verification persists `config.lastVerifiedGrokVersion` per workspace without pinning the CLI. Setup compares the stored and reported strings before advancing the stored value, emits `versionDrift: { previous, current }` plus a prominent warning on change, and leaves the stored version untouched when availability/auth verification fails.
- The fake Grok version is overridable through `FAKE_GROK_VERSION`; runtime coverage verifies first storage, JSON and human drift warnings, failed-auth retention, successful advancement, and one-time clearing. Setup command guidance now requires Claude to surface drift prominently.
- Verified: `node --test tests/*.test.mjs` — 64 tests total, 60 passed, 0 failed, 4 skipped because this sandbox blocks Unix socket listeners.

## Phase 2 design (grilled 2026-07-10; Fable advised the adversarial prompt)

Posture: faithful port of codex's Phase-2 surface; deviate only where Grok's runtime forces it, each deviation flagged.

### Stop-review-gate

- Mechanism (faithful): `Stop` hook → `grok-companion task --json <turn-scoped prompt>`; parse first line `ALLOW:`/`BLOCK:`. Reuse codex's turn-scoped `stop-review-gate.md` (rebranded Grok) — reviews the *previous turn's* edits via `last_assistant_message` + repo state, not a diff. Independent of the two diff-scoped review commands.
- Opt-in, default off (`config.stopReviewGate`); re-add the toggle to `/grok:setup --enable-review-gate|--disable-review-gate` (Phase 1 dropped it) + companion `handleSetup`. Add a `Stop` entry to `hooks/hooks.json`. Keep the running-job note even when the gate is off (faithful).
- Forced deviation — busy broker: Grok's broker rejects a concurrent request from a different socket with `-32001` (per-connection lock, no queue — `acp-broker.mjs:340`). If a grok job is in flight at Stop, skip the review, ALLOW the stop, surface the running-job note. Only review when the broker is free.
- Time bound: explicit `--budget-ms` ~8m (broker `session/cancel`, graceful), subprocess timeout ~10m, hook `timeout` ~12m — ordered `budget < subprocess < hook` so graceful cancel fires first (no orphaned grok children). Shorter than the 20m job default since it blocks the user's Stop.
- Fail mode (faithful): fail-open on not-set-up and busy; fail-closed (`decision: block`) on a genuine review failure (BLOCK verdict / timeout / non-zero exit / empty / invalid). Escape hatch `/grok:setup --disable-review-gate`. Accepted risk: persistent infra failure can stop-loop.

### Review split (Option A)

- `/grok:review`: re-scoped to a calm defect/correctness review (bug-hunt). Stays focus-less. Behavior change to a signed-off Phase-1 command → re-verify with the planted-bug case.
- `/grok:adversarial-review`: new command + new companion `adversarial-review` subcommand (reuses review target/collection, accepts focus text → `{{USER_FOCUS}}`). Design-challenge pass.
- Differentiation lives in the attack surface, not tone: adversarial swaps `attack_surface` → `design_attack_surface` (one-way doors, wrong-layer, symptom-patches, load-bearing assumptions, complexity-without-need, scope). Sharing the defect attack surface would make the split cosmetic (Fable).
- Adversarial prompt (Fable-authored, sharper-but-grounded): burden-of-proof (not "assume the approach is wrong"); named-alternative-with-costs per finding; steelman-then-break; "undefended design commitment" finding type; evidence-or-drop inside the method loop; confidence ≤0.6 for inference-based findings; anchor rule (never invent line ranges for the defect-shaped schema); approve-is-success in the role block; drop "no credit for partial fixes" (punishes incrementalism) → "a small reversible step is not a flaw; a small step that locks in the wrong structure is."
- Known follow-ups (not preemptive): if live runs show design findings contorted into line ranges, add `category: design|defect` to `review-output.schema.json`. Hostile calibration is defensible only because this is a user-invoked advisory second opinion — revisit if it ever gates CI.

### grok-prompting skill

- Research-first, thin, honestly-attributed: distill only what xAI officially documents (no local guide — `~/.grok/docs` is operational-only; fetch xAI's public prompt guidance during impl); fill gaps with clearly-labeled model-agnostic prompt craft, NOT attributed to xAI; import zero GPT-specific content. Short SKILL.md + ≤1 reference. Wire into the `grok-rescue` agent's `skills` list (Phase 1 left it out).

## Build log — touched-file capture (2026-07-10)

- Decode edit-shaped ACP tool events into per-turn, deduplicated `touchedFiles`, preferring `locations[].path`, then diff-content paths, then writable `rawInput.file_path`; realistic write/read fixture coverage added.
- Verified: `node --test tests/*.test.mjs` — 65 tests total, 61 passed, 0 failed, 4 socket-gated skips.

## Build log — slice 1 adversarial-review subcommand (2026-07-10)

- Added selectable review prompt coupling (defaulting to `review`), the focus-aware `adversarial-review` companion dispatch, and adversarial job-kind/status labeling while reusing the review runtime and job class. Added template-selection, focus-plumbing, job-kind, and plain-review regression coverage.
- Deviations: none. The parallel-owned review prompts and shared review schema were not edited.
- Verified: `node --test tests/*.test.mjs` — 68 tests total, 64 passed, 0 failed, 4 socket-gated skips.
- Orchestrator follow-up (2026-07-11): reviewer pass on the full slice diff returned a clean-ship verdict + one should-fix and two nits. Applied: (1) should-fix — the runtime test proved focus interpolation but not adversarial-*template* selection through the companion (`review.md` also interpolates `{{USER_FOCUS}}`), so dropping `promptName` would have passed silently; added `assert.match(prompt, /design_attack_surface/)` + `assert.doesNotMatch(prompt, /<attack_surface>/)` in `tests/runtime.test.mjs` to pin the wiring end-to-end. (2) nit — threaded `reviewLabel`/`jobTitle` through `executeReviewRun` so the rendered adversarial result header reads "Adversarial Review" (was "Review"); default preserves the plain-review path byte-for-byte. (3) nit dismissed — reviewer flagged a stray `</output>` in both prompts; verified false (both end at `</repository_context>`; the pre-existing artifact was already dropped in the re-scope). Suite re-run: 68/68 green (0 skipped on host).
- Live verification (real grok 0.2.93, broker restarted first): re-scoped `/grok:review` on a planted overdraft bug (removed sufficient-funds guard) → `needs-attention`, critical, conf 0.99, correct file/lines, `parseError: null` — no lost teeth. New `/grok:adversarial-review` on a symptom-patch diff (swallow-all-errors config parse) with focus text → two grounded design findings (undefended-commitment + wrong-layer defaulting), each with a named alternative and its costs, header "Adversarial Review", `parseError: null`. Both fixture brokers/children cleaned up after.

## Build log — slice 2 stop-review-gate (2026-07-10)

- Added the opt-in setup toggle/reporting and Grok-branded Stop hook with the required fail-open gate-off/setup/busy paths and fail-closed verdict/timeout/process/output paths. The internal `stop-review-task` dispatch uses an eight-minute budget, no model/effort override, `persistThread: false`, `brokerFallback: false`, and `jobClass: "stop-review"`.
- Fable-flagged guards: running records require a live PID (or a recent timestamp when PID-less), broker `-32001` becomes a structured busy payload only for the gate path, stop-review jobs are excluded from resume selection, and broker-fallback control is plumbed through `executeTaskRun` → `runAcpTurn` → ACP connect. Tests pin stale dead-PID review execution, `lastTaskSession` preservation, and resume exclusion.
- Deviations: Grok busy handling is workspace-scoped and fail-open; bounds are 8-minute ACP budget, 10-minute subprocess timeout, and the prewritten 12-minute hook ceiling. A test-only subprocess path/timeout override keeps timeout and malformed-payload tests hermetic; production defaults use the sibling companion and exact 10-minute bound.
- Verified: `node --test tests/*.test.mjs` — 84 tests total, 79 passed, 0 failed, 5 skipped because this sandbox blocks Unix socket listeners.
- Orchestrator follow-up (2026-07-11): reviewer pass returned ship-with-two-should-fixes. Applied: (1) the busy pre-check's stale-`running` liveness guard didn't cover `queued` jobs — a detached worker that dies before flipping to `running` would leave a `queued` record with a dead pid and disable the gate forever; unified `queued`+`running` through the same `processIsAlive(pid)` + age-cutoff path (`job.pid` is the worker pid in both states — `updateJobChildPid` writes a separate `childPid`). Also made an unparseable-timestamp record default to not-in-flight (run the review — the safe direction). (2) added the missing null-pid young→skip / null-pid stale→dispatch tests. 86/86 green.
- Live-exposed defect + fix (the class of gap only live runs surface — Fable advised the parse relaxation): real grok 0.2.93 does NOT obey the "verdict token on the first line, nothing before it" contract — it prepends a preamble sentence glued onto the verdict on the same line (`I'll verify whether the previous turn actually changed code…ALLOW: …`). The faithful codex first-line parser fail-closed on EVERY turn → permanent stop-loop, gate unusable. Fix (`parseStopReviewOutput`): keep the anchored first-line check as tier 1, add a tier-2 fallback that scans for a boundary-guarded, case-sensitive verdict token `/(?<![A-Za-z])(ALLOW|BLOCK):/g` (lookbehind stops `DISALLOW:` matching); one distinct verdict wins (BLOCK reason = post-token text to end-of-line, no preamble leak), zero-or-both-distinct fails closed with a diagnostic excerpt. Hardened the prompt too (verdict must be the very first characters; don't write the tokens anywhere but the verdict line) — secondary, since grok ignored the existing instruction twice. Added 5 parser tests using the real captured grok strings as fixtures.
- Live verification (real grok 0.2.93): `/grok:setup --enable-review-gate` toggles config + surfaces the action ✓; ALLOW round-trip on a correct edit → empty stdout/allow ✓; BLOCK round-trip on a no-base-case `factorial` → `{decision:"block"}` with a clean preamble-free reason ✓; busy-skip with a real in-flight background job → skip+allow + running-job note ("from another session", workspace-scoped skip / session-scoped note) ✓. Fixture broker/children cleaned up.
- Full suite after all fixes: `node --test tests/*.test.mjs` — 90 tests, 90 passed, 0 failed, 0 skipped (on host; sockets available).

## Build log — slice 3 grok-prompting skill (2026-07-11)

- Research-first authoring (orchestrator, not delegated — pure markdown + web research, no runtime coupling). Live-fetched xAI's official prompt guidance and wrote `skills/grok-prompting/SKILL.md` (thin) + one reference `references/grok-prompt-guidance.md`. Wired `grok-prompting` into the `grok-rescue` agent `skills` list after `grok-cli-runtime` (kept the existing skills-list test regex satisfied by appending, not prepending).
- Attribution design honored exactly: Part 1 = xAI-official only, each point linked to its docs.x.ai source (grok-code-prompt-engineering, build/overview, prompt-caching/best-practices) with exact xAI phrasing; Part 2 = general model-agnostic craft explicitly labeled NOT xAI. Zero GPT/codex/OpenAI content (test-enforced). Honest caveat recorded: xAI's prompt guide targets grok-code-fast-1 while Grok Build defaults to grok-4.5 — structural points are model-general, the model-selection point is not.
- Sources research note: xAI's *general* Generate Text guide (docs.x.ai/docs/guides/chat) carries no prompt-quality best practices — only API mechanics — so the grok-code-fast-1 guide is the real xAI-official prompt source. Forward-risk: if grok-code-fast-1's xAI docs page is ever pulled (some third-party platforms are deprecating that model ~Aug 2026), re-verify Part 1's citations.
- Verified: added `tests/commands.test.mjs` case asserting honest attribution + xAI sourcing + zero-other-vendor content + agent wiring. doc-reviewer independently corroborated all four cited sources against the live pages — attribution accurate, no corrections. Full suite: `node --test tests/*.test.mjs` — 91 tests, 91 passed, 0 failed, 0 skipped (on host).

## Build log — Grok 0.2.103 / cross-plugin broker isolation (2026-07-17)

- Issue #4 looked like a Grok ACP migration because `session/new` failed with a list of `thread/*` and `turn/*` methods. Live inspection showed those were Codex app-server methods: Grok's state directory contained Codex jobs and its `broker.json` pointed at a live `cxc-*` Codex broker. Grok 0.2.103 still supports ACP `session/*`; isolated direct and default-broker task round-trips both completed.
- Root cause: both plugins' SessionStart hooks re-exported generic `CLAUDE_PLUGIN_DATA` into Claude Code's shared environment. Hook order could redirect either plugin to the other's data root. Grok now captures its plugin-scoped path as `GROK_COMPANION_DATA_DIR`, and state resolution prefers that stable, namespaced value while retaining `CLAUDE_PLUGIN_DATA` as an out-of-harness fallback.
- Broker initialization now requires `_meta.broker: "grok-companion"`. A persisted foreign endpoint is removed and the current request falls back to a direct Grok child; the next request can create a clean Grok broker. New broker records carry the same identity marker, and unverified stale records are cleared without trusting their PID or filesystem paths. Shutdown performs the identity handshake before sending `broker/shutdown`, avoiding teardown of another plugin's broker.
- TDD: added failing regressions for namespaced data precedence, SessionStart exports, persisted Codex-broker rejection/direct fallback, safe foreign-broker shutdown, startup refusing to teardown an unverified stale record, and SessionEnd refusing to teardown an unverified broker record before implementing each runtime change.
- Verification: full hermetic suite 103/103; `scripts/phase2-live-smoke.sh` against Grok 0.2.103 passed 15/15 with zero inconclusive checks (review, adversarial review, setup toggle, Stop ALLOW/BLOCK, busy skip, gate off).
- Notable existing debt: the full test run and live-smoke cleanup left some detached generated workers/brokers alive; they were manually terminated. Cleanup ownership is outside issue #4's scope but should be tightened separately.
- Scope: patch release 0.2.2; no ACP method migration and no Grok version pin. Historical 0.2.93 verification notes remain historical; the fake CLI and release compatibility baseline move to 0.2.103.

## Build log — issue #5 job registry + dead-worker reaping (2026-07-19)

- Root cause (a): session-shell `status`/`cancel` trusted ambient `CLAUDE_PLUGIN_DATA`, which another plugin's SessionStart can set (e.g. `codex-openai-codex`). Grok-rescue jobs write under `GROK_COMPANION_DATA_DIR` / grok data; shell commands then miss those jobs.
- Fix (a): `resolvePluginDataDir` prefers `GROK_COMPANION_DATA_DIR`; only accepts ambient `CLAUDE_PLUGIN_DATA` when `isLikelyGrokPluginDataDir` (basename `^grok(?:[-_.@]|$)`); else temp fallback.
- Root cause (b): `resolveLatestTrackedTaskThread` treated any `queued`/`running` as live with no pid check → dead workers blocked `--resume-last` forever; wrong registry made cancel useless.
- Fix (b): shared `processIsAlive` + `isJobInFlight` + `reapDeadJobs` (mark failed, clear pids); called from status/cancel/resume-last. Stop gate imports the same in-flight helper.
- Fix (c): status snapshot/text include `stateFile`; cancel and still-running errors append `State file: …`.
- Verification: `node --test tests/*.test.mjs` (full suite). Version 0.2.3.
