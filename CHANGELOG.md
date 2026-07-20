# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [RELEASING.md](RELEASING.md) for the versioning policy and release process — in
particular, **any change to the installed plugin surface must ship a version bump** or
Claude Code's `/plugin update` silently no-ops on the stale snapshot.

## [Unreleased]

## [0.2.4] - 2026-07-20

Job forensics and rescue reliability for long turns (#6 class).

### Added

- Job forensics on every tracked run: progress checkpoints (`lastProgressAt`,
  partial assistant text), catchable death handlers, and
  `jobs/<id>.dump.json` when a turn dies uncleanly.
- `reapDeadJobs` upgrades dead workers with `deathKind: reaped-dead-worker` and
  a dump so hard kills are diagnosable later.
- Tracked-job recovery banner on every `task` (and review foreground runs):
  job id plus `/grok:status` / `/grok:result` / `/grok:cancel` hints.
- Rescue/agent/runtime/result-handling docs lead with the job registry so
  forwarders cannot miss tracking, recovery, or dumps.

### Changed

- Default `task` (and `--wait`) is now **detach-wait**: spawn a detached
  `task-worker`, print the job id, wait for completion, then print the stored
  result. A killed waiting parent no longer kills the turn; recover via status/result.
- Fire-and-forget remains `task --background` (write still requires a clean tree).
- `SessionEnd` kills active workers but **preserves** job records as
  `cancelled` with `deathKind: session-end` (no more silent delete of evidence).
- Status/result rendering surfaces forensics fields when present.

## [0.2.3] - 2026-07-19

Job registry isolation and stuck-job recovery (#5).

### Fixed

- `#5` Ambient `CLAUDE_PLUGIN_DATA` is no longer trusted for the job registry unless
  the directory name looks like a Grok plugin data root (e.g. `grok-…`). Prefer
  `GROK_COMPANION_DATA_DIR` always; otherwise fall back to the temp state root.
  This stops session-shell `status`/`cancel` from reading the Codex companion's
  registry when both plugins are installed.
- `#5` Queued/running jobs whose worker pid is dead (or null-pid past the age
  cutoff) are reaped to `failed` before status, cancel, and `task --resume-last`,
  so a crashed worker no longer permanently blocks resume.
- `#5` `status` (text + JSON) and cancel/"still running" errors report the
  `state.json` path they consulted, so the next wrong-registry case is one step
  to diagnose.

### Changed

- Shared `processIsAlive` / `isJobInFlight` / `reapDeadJobs` helpers; the Stop
  review gate reuses the same liveness rules.

## [0.2.2] - 2026-07-17

Compatibility and isolation fix for Grok CLI 0.2.103 when the Grok and Codex plugins
run in the same Claude Code session.

### Fixed

- `#4` Grok state now uses the plugin-specific `GROK_COMPANION_DATA_DIR` exported by
  the SessionStart hook instead of re-exporting shared `CLAUDE_PLUGIN_DATA`. This prevents
  Codex state and broker endpoints from contaminating Grok jobs.
- Broker connections validate the `grok-companion` identity during `initialize`. A stale
  foreign endpoint is discarded and the current job falls back to a direct Grok ACP child
  instead of sending `session/new` to a Codex app-server. Persisted Grok broker records now
  carry the same ownership marker.
- Startup and shutdown never trust PID or filesystem paths from an unverified broker record,
  so they cannot stop or remove another plugin's broker resources.

### Changed

- Hermetic and live compatibility baselines now target Grok CLI 0.2.103.

## [0.2.1] - 2026-07-14

Runtime reliability fixes for long jobs and resume, plus docs/release tooling that had
been sitting unreleased.

### Fixed

- `#2` `--resume-last` reloads the prior Grok ACP session via `session/load` when the
  thread still exists (was always `session/new` with a summary prompt). Falls back to a
  seeded new session only when load is unavailable or the thread is gone.
- `#1` Job budget expiry cancels the productive turn, then runs a short wind-down handoff
  so mid-turn work can leave a recoverable note. Companion usage documents `--budget-ms`
  (default 20 minutes).
- `#3` `status --wait` defaults to the job's budget deadline (`startedAt + budget + grace`),
  re-resolved each poll (was a fixed 4 minutes that produced phantom failures). Wait
  timeout exits 2 with the still-active job state — not a job failure.
- Live-smoke script derives the repo root from its own path instead of a hard-coded
  machine-local absolute path.

### Added

- Release discipline: changelog process, `RELEASING.md`, version-lockstep tests, and
  `scripts/bump-version.sh`.
- README Troubleshooting section (symptom → cause → fix for designed guardrails).
- `docs/architecture.md`: component map, dispatch sequence, job lifecycle, and stop-gate
  decision flow.

### Security

- Documented the `grok --debug-file` OAuth-token-in-logs risk in the README Safety model.

## [0.2.0] - 2026-07-11

Phase 2 — parity with the codex plugin's second-phase surface.

### Added

- `/grok:adversarial-review` command + companion subcommand: a design-challenge review that
  attacks the approach and its commitments (one-way doors, wrong-layer logic, symptom-patches,
  load-bearing assumptions) rather than line-level bugs, and accepts free-text focus.
- Opt-in stop-review gate: a `Stop` hook that reviews the previous turn's edits and can block
  ending the session, toggled via `/grok:setup --enable-review-gate|--disable-review-gate`
  (default off). Fails open when the gate is off, Grok isn't set up, or the broker is busy;
  fails closed on a genuine review failure.
- `grok-prompting` skill, grounded in xAI's official prompt guidance, wired into the
  `grok-rescue` agent.
- `scripts/phase2-live-smoke.sh`: a repeatable behavioral smoke of the Phase 2 surface against
  the real `grok` CLI.

### Changed

- `/grok:review` re-scoped from a skeptical/adversarial pass to a calm defect/correctness
  bug-hunt; design critique now lives in `/grok:adversarial-review`.

## [0.1.0] - 2026-07-10

Phase 1 — core loop. Initial release.

### Added

- Grok Build delegation and review from Claude Code via a persistent, per-workspace broker
  speaking ACP to sandboxed `grok agent` children.
- Commands: `/grok:rescue`, `/grok:review`, `/grok:status`, `/grok:cancel`, `/grok:result`,
  `/grok:setup`.
- `grok-rescue` agent; `grok-cli-runtime` and `grok-result-handling` skills.
- Session-lifecycle hooks and broker guardrails: per-job wall-clock budget, standing
  no-commit/no-push rules, and a clean-tree requirement for background write jobs.

[Unreleased]: https://github.com/fuentesjr/grok-plugin-cc/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/fuentesjr/grok-plugin-cc/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/fuentesjr/grok-plugin-cc/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/fuentesjr/grok-plugin-cc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fuentesjr/grok-plugin-cc/releases/tag/v0.1.0
