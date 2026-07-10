# Porting map — codex-plugin-cc → grok plugin

Derived 2026-07-10 from a full survey of the reference checkout at
`~/.claude/plugins/marketplaces/openai-codex/`. This is the working spec for the
structural port. Read alongside `implementation-notes.md` and `docs/adr/`.

## Module classification

**Rewrite against ACP** (codex app-server protocol/event vocabulary):

| Reference | Port target | Notes |
|---|---|---|
| `scripts/lib/app-server.mjs` | `scripts/lib/acp-client.mjs` | NDJSON JSON-RPC framing, request/id correlation, notification dispatch. Keep the class shape: connect → request/notify → notificationHandler → close, pluggable broker-socket vs direct-spawn transport. ACP handshake: `initialize` (protocolVersion 1, fs caps false) per spike. |
| `scripts/lib/codex.mjs` (1220 lines) | `scripts/lib/grok.mjs` | The core rewrite. Two clusters: (1) turn-capture state machine — re-decode against ACP `session/update` kinds `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`; (2) service functions — **preserve the public signatures** so callers port cleanly: `runAppServerTurn`→`runAcpTurn`, `runAppServerReview`→`runAcpReview` (prompt-driven, no native review), `interruptAppServerTurn`→`cancelAcpTurn` (`session/cancel`, stopReason `cancelled`), `getCodexAvailability`→`getGrokAvailability`, auth status, `parseStructuredOutput`, `readOutputSchema`. |
| `scripts/app-server-broker.mjs` | `scripts/acp-broker.mjs` | Rewrite for ADR 0002: broker owns up to TWO children spawned as `grok --sandbox <profile> agent --no-leader --always-approve stdio` — `read-only` at start, `workspace` lazily on first write job; route each job's session to the child matching its access level. Keep: unix-socket endpoint, busy-lock with cancel carve-out (`BROKER_BUSY_RPC_CODE -32001`), `broker/shutdown`. Add broker guardrails: per-job wall-clock budget → `session/cancel`; standing `_meta.rules` (no `git commit`/`git push`, stay in workspace) on every `session/new`. |
| `lib/app-server-protocol.d.ts` | (drop) | Dev-time types optional; ACP surface is 5 methods. |
| `tests/fake-codex-fixture.mjs` | `tests/fake-grok-fixture.mjs` | Fake `grok` executable installed into a binDir (PATH-prepended). Must accept `--sandbox <profile> agent --no-leader --always-approve stdio` arg shapes and record the profile for assertions. Speaks ACP: `initialize`, `session/new` (capture `_meta.rules`), `session/prompt` emitting `session/update` sequences, `session/cancel` → prompt resolves `stopReason: "cancelled"`. Keep the reference's BEHAVIOR-string scenario design: completing turn, streaming turn, hanging turn (for cancel/budget), auth-failure, invalid-json, review-json output, slow interruptible task. |

**Rename-only / light edits:** `broker-endpoint.mjs` (pipe suffix), `broker-lifecycle.mjs` (spawns `acp-broker.mjs`; `broker/shutdown` is broker-internal, keep), `job-control.mjs` (log-phrase regexes in `inferLegacyJobPhase`/`isProgressBlockTitle` must match grok.mjs's progress wording — keep in lockstep), `render.mjs` (swap Codex-branded strings; keep the tolerant review-shape validator).

**Verbatim ports:** `args.mjs`, `fs.mjs`, `prompts.mjs`, `process.mjs`, `workspace.mjs`, `git.mjs`, `state.mjs` (rename fallback dir/slug to `grok-companion`), `tracked-jobs.mjs` (env → `GROK_COMPANION_SESSION_ID`; keep progress-event contract `{message, phase, threadId, turnId, stderrMessage, logTitle, logBody}` — map thread/turn ids to ACP session/turn), `schemas/review-output.schema.json`, `tests/helpers.mjs`, test harness pattern (`node --test tests/*.test.mjs`).

**Deferred to Phase 2:** `adversarial-review`, `stop-review-gate-hook.mjs` + Stop hook entry, prompting skill.

**Dropped 2026-07-10:** `claude-session-transfer.mjs`, `transfer` subcommand (see `implementation-notes.md`).

## Companion CLI contract (mirrors reference `codex-companion.mjs`)

`scripts/grok-companion.mjs`, subcommands: `setup`, `review`, `task`, `task-worker`
(internal, detached bg worker), `task-resume-candidate` (internal, `--json`),
`status`, `result`, `cancel`. Conventions: `-C` aliases `--cwd`; single-string
argv re-split via `splitRawArgumentString` (`"$ARGUMENTS"` idiom); `--json`
everywhere; model alias `fast` → `grok-composer-2.5-fast`; effort passthrough;
task flags `--write`, `--resume`/`--resume-last`/`--fresh`, `--background`,
`--prompt-file`. Background+write requires a clean tree (ADR 0002).

## Env vars

`GROK_COMPANION_SESSION_ID`, `GROK_COMPANION_TRANSCRIPT_PATH`,
`GROK_COMPANION_ACP_ENDPOINT`, plus standard `CLAUDE_PLUGIN_DATA`,
`CLAUDE_PLUGIN_ROOT`, `CLAUDE_ENV_FILE`.

## Command .md conventions (from reference)

Frontmatter: `description`, `argument-hint`, `allowed-tools`, and
`disable-model-invocation: true` on passthroughs. Two idioms:
- Passthrough (`cancel`, `result`, `status`): body is one inline
  `` !`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" <sub> "$ARGUMENTS"` `` line + render instructions.
- Model-orchestrated (`review`, `setup`, `rescue`): AskUserQuestion exactly once
  (first option suffixed `(Recommended)`), background via `run_in_background: true`,
  "review-only, do not fix", "return output verbatim", "preserve $ARGUMENTS exactly".
`rescue.md` routes through the `grok-rescue` subagent (Agent tool), which makes
exactly one Bash call to `grok-companion.mjs task ...` and returns stdout verbatim.
Agent frontmatter mirrors reference: `name`, `description`, `model: sonnet`,
`tools: Bash`, `skills: [grok-cli-runtime]`. Skills are `user-invocable: false`.

## hooks/hooks.json (Phase 1)

`SessionStart`/`SessionEnd` only → `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" <event>`,
timeout 5. SessionStart appends env exports to `$CLAUDE_ENV_FILE`; SessionEnd
tears down broker + cleans up the session's jobs.

## Review schema

`schemas/review-output.schema.json`: copy the reference shape verbatim —
root requires `verdict` (`approve|needs-attention`), `summary`, `findings[]`
(`severity critical|high|medium|low`, `title`, `body`, `file`, `line_start`,
`line_end`, `confidence` 0–1, `recommendation`), `next_steps[]`. Grok has no
native reviewer and ACP has no outputSchema param: the review prompt instructs
strict JSON output; `parseStructuredOutput` extracts it; `render.mjs`'s tolerant
validator is the safety net.

## Verified ACP facts (spike, grok 0.2.93 — do not re-litigate)

- Spawn: `grok --sandbox <profile> agent --no-leader --always-approve stdio`
  (`--sandbox` is global-only; rejected after `agent`).
- `read-only` sandbox is kernel-enforced (but permits temp-dir writes; probes must
  live outside temp dirs). Child network blocking is a no-op on macOS.
- `_meta.agentProfile` is prompt-shaping only; malformed profiles silently fall
  back. Never rely on it for restriction.
- `session/cancel` honored mid-turn → `stopReason: "cancelled"`.
- No `--allow`/`--deny`/`--max-turns` in agent mode; broker owns guardrails.
- Never enable `--debug-file` in shipped paths (leaks OAuth bearer token).
