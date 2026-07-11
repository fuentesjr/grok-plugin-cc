# grok-plugin-cc

A Claude Code plugin that delegates investigation, fixes, and code review to Grok Build (xAI's `grok` CLI) over [ACP](https://agentclientprotocol.com), structurally ported from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) so the two plugins feel interchangeable.

## Requirements

- macOS (the only supported platform).
- Node.js 18.18 or later.
- The `grok` CLI, installed and logged in:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

## Install

Add this repo as a Claude Code marketplace:

```bash
/plugin marketplace add fuentesjr/grok-plugin-cc
```

Or, from a local checkout:

```bash
/plugin marketplace add /path/to/grok-plugin-cc
```

Then install the plugin and reload:

```bash
/plugin install grok@grok
/reload-plugins
```

Verify the CLI is ready:

```bash
/grok:setup
```

`/grok:setup` checks Node, the `grok` binary, and login state, and offers to run the installer for you if `grok` is missing.

## Quick start

```bash
/grok:setup
/grok:rescue investigate why the tests are failing on this branch
/grok:review --background
/grok:status
```

## Command reference

| Command | What it does | Key flags |
|---|---|---|
| `/grok:setup` | Checks whether Grok Build is installed and authenticated; offers to install it. Also toggles the optional stop-review gate | `--enable-review-gate\|--disable-review-gate` |
| `/grok:rescue <request>` | Delegates investigation, an explicit fix, or follow-up work to the `grok-rescue` subagent | `--background\|--wait`, `--resume\|--fresh`, `--model <model\|fast>`, `--effort <none\|minimal\|low\|medium\|high\|xhigh>` |
| `/grok:review` | Runs a read-only Grok Build review of the working tree or a branch diff, focused on correctness defects | `--wait\|--background`, `--base <ref>`, `--scope auto\|working-tree\|branch` |
| `/grok:adversarial-review [focus]` | Runs a read-only Grok Build review that challenges the design and approach rather than hunting line-level bugs; accepts free-text focus | `--wait\|--background`, `--base <ref>`, `--scope auto\|working-tree\|branch` |
| `/grok:status [job-id]` | Shows active and recent Grok jobs for this repository | `--wait`, `--timeout-ms <ms>`, `--all` |
| `/grok:result [job-id]` | Shows the stored final output for a finished job | — |
| `/grok:cancel [job-id]` | Cancels an active background job | — |

### `/grok:rescue`

- Runs in the foreground by default; pass `--background` to run it as a background Claude task.
- Without `--resume` or `--fresh`, Claude checks for a resumable Grok thread from this session and asks once (via `AskUserQuestion`) whether to continue it or start fresh. `--resume`/`--fresh` skip that prompt.
- `--model` passes through to Grok's model selection; `fast` maps to `grok-composer-2.5-fast`. Leave it unset to use Grok's own default.
- `--effort` passes through Grok's reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) and is left unset unless you ask for it.
- The `grok-rescue` subagent defaults to a write-capable run unless you ask for read-only behavior, review, or diagnosis only.

### `/grok:review`

- A calm defect/correctness pass: it hunts real bugs — broken logic, unhandled failure paths, boundary and concurrency errors — not design taste or style.
- `--base <ref>` reviews the current branch against `<ref>` instead of the working tree.
- `--scope auto|working-tree|branch` forces the review target when the default detection isn't what you want.
- Always read-only: it never applies fixes. Findings are presented for you to triage; Claude asks before touching any file.
- No custom focus text, and no staged-only/unstaged-only scoping — it reviews the working tree or a branch diff, full stop.

### `/grok:adversarial-review`

- A design-challenge pass: it pressure-tests the approach and its commitments (one-way doors, wrong-layer logic, symptom-patches, load-bearing assumptions, complexity-without-need) rather than line-level bugs. Use it as a second opinion on *whether the approach is right*, alongside `/grok:review` for *whether the code is correct*.
- Takes optional free-text focus after the flags, e.g. `/grok:adversarial-review is the caching layer at the right level?` — the focus is passed to the reviewer verbatim.
- Same targeting as `/grok:review` (`--base <ref>`, `--scope auto|working-tree|branch`); same read-only guarantee. Each finding names a concrete alternative and its costs; approving a sound design is a valid outcome.

## How it works

Each workspace gets its own Broker — a persistent companion process, started on first use and torn down when the Claude Code session ends — that owns the connection to Grok Build and mediates every Job (a Rescue or a Review) dispatched to it. The Broker speaks ACP (JSON-RPC 2.0) to `grok` children it spawns and manages directly — Claude Code never talks to `grok` itself.

```
Claude Code session
      │  grok-companion.mjs (ACP client)
      ▼
   Broker (one per working directory)
      │
      ├── read-only child  ── grok --sandbox read-only  agent --no-leader --always-approve stdio
      │   spawned at broker start; default for every job
      │
      └── workspace child  ── grok --sandbox workspace  agent --no-leader --always-approve stdio
          spawned lazily on the first job that requests --write
```

Sandbox profile binds at process spawn, so the Broker keeps up to two children alive rather than switching sandboxes per job. Write jobs run in place in the project working tree, not in an isolated worktree.

Because agent mode has no interactive approval flow, children run auto-approved and the Broker owns the guardrails a headless CLI would otherwise provide:

- **Per-job budget**: every Job gets a 20-minute wall-clock budget by default (override with `--budget-ms` or `GROK_COMPANION_BUDGET_MS`); on expiry the Broker sends `session/cancel` and marks the Job failed.
- **Standing rules**: every session carries prompt-level rules forbidding `git commit`/`git push` and work outside the workspace.
- **Clean-tree requirement**: a background write Job requires a clean working tree, so it can't race with the live Claude Code session editing the same files. Commit, stash, or run with `--wait` instead.

Results are trust-but-verify: Grok's claim of a green run is never taken at face value. After a write Job, Claude re-runs the verification command itself; review findings are treated as candidates and checked against the code before being surfaced.

## Safety model

- **The sandbox is the hard boundary, not the prompt rules.** The `read-only`/`workspace` sandbox profile is kernel-enforced at process spawn — under `read-only`, every write path fails with `Operation not permitted`. The standing no-commit/no-push rules above are prompt-level guidance only and should not be relied on for enforcement.
- **Known gap**: Grok's child-process network blocking is a no-op on macOS. Read-only jobs are filesystem-confined but not network-confined.
- **Version drift**: `/grok:setup` records the last-verified `grok` version per workspace. If the installed version changes, it surfaces a prominent warning with both versions and recommends a cheap read-only `/grok:rescue` to re-verify behavior before trusting further runs.

## Stop-review gate (optional, off by default)

An opt-in `Stop` hook that runs a quick Grok review of the previous turn's edits before Claude Code ends the session, and blocks the stop if Grok finds something that should be fixed first.

- **Enable/disable per workspace**: `/grok:setup --enable-review-gate` / `/grok:setup --disable-review-gate`. It is off unless you turn it on, and `/grok:setup` shows the current state.
- **Only reviews real edits**: turns that were just status, setup, or a review result are allowed through without a review.
- **Skips when Grok is busy**: if a Grok job is already in flight for the workspace (the Broker is per-directory and single-flight), the gate skips the review and lets the stop through, surfacing a note about the running job. It only reviews when the Broker is free.
- **Fail-open vs fail-closed**: it fails *open* (allows the stop) when the gate is off, Grok isn't set up, or the Broker is busy; it fails *closed* (blocks) on a genuine review failure — a BLOCK verdict, timeout, or unusable output. The escape hatch if it ever gets in your way is `/grok:setup --disable-review-gate`.
- **Time-bounded**: the nested review runs under an 8-minute Grok budget inside a 10-minute subprocess timeout inside a 12-minute hook ceiling, so a graceful cancel fires before anything is force-killed.

## Development

```bash
npm test
```

Runs the hermetic `node --test` suite against a fake `grok` executable (`tests/fake-grok-fixture.mjs`) that speaks minimal ACP — no real Grok CLI or network access required.

Repo layout:

```
.claude-plugin/marketplace.json   marketplace definition
plugins/grok/                     the plugin: commands, agents, skills, scripts, hooks, schemas, prompts
docs/adr/                         accepted architecture decisions
docs/porting-map.md               module-by-module port plan vs. codex-plugin-cc
tests/                            node --test suite + fake-grok ACP fixture
implementation-notes.md           locked decisions, failure handling, verification log
```

## Attribution & license

Apache-2.0. Adapted from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see `NOTICE`.
