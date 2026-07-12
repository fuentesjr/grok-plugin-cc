# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [RELEASING.md](RELEASING.md) for the versioning policy and release process — in
particular, **any change to the installed plugin surface must ship a version bump** or
Claude Code's `/plugin update` silently no-ops on the stale snapshot.

## [Unreleased]

### Added
- Release discipline: this changelog, `RELEASING.md`, a `node --test` case that fails if
  the version strings drift or a changelog entry is missing, and `scripts/bump-version.sh`
  to bump all manifests in lockstep and roll this file.
- README Troubleshooting section: symptom → cause → fix for the plugin's designed-behavior
  guardrails (stale install/broker, the stop-gate escape hatch, job budget, clean-tree
  refusal, no-commit rules), linking to the canonical sections.
- `docs/architecture.md`: Mermaid diagrams of the component map, job dispatch sequence,
  job lifecycle state machine, and stop-review-gate decision flow, validated with
  mermaid-cli and linked from the README.

### Security
- Surfaced the `grok --debug-file` warning into the README Safety model: its logs record the
  OAuth bearer token in plaintext (previously noted only in internal implementation notes).

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

[Unreleased]: https://github.com/fuentesjr/grok-plugin-cc/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fuentesjr/grok-plugin-cc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fuentesjr/grok-plugin-cc/releases/tag/v0.1.0
