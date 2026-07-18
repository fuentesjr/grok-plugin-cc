# STATE

## Goal
Phases 0–2 are signed off and released (0.2.x). Hermetic suite + phase2 live smoke are the regression bar. Decisions live in implementation-notes.md and docs/adr/. Reference implementation: openai-codex Claude plugin. No active phase checklist — pick work from backlog or an explicit user order.

## Dispatched

## Next
1. No standing next steps; pick from backlog or an explicit user work order.

## Backlog
- worktree-isolation — Deferred by design: worktree isolation for background write jobs — only if the clean-tree guard ever chafes (2026-07-18T08:38Z)
- broker-restart-after-plugin-edit — Runtime gotcha: after changing plugin code, restart the broker (kill pid + remove broker.json) or live runs exercise stale code (2026-07-18T08:38Z)
- bump-version-on-surface-change — Install gotcha: harness uses installed plugin snapshot — bump version on plugin surface changes or /plugin update no-ops; /reload-plugins re-registers hooks without full restart (2026-07-18T08:38Z)
- codex-fresh-dispatch — Dispatch gotcha: codex --resume-last does not resolve in this repo — dispatch codex fresh with a self-contained brief for runtime-coupled work (2026-07-18T08:38Z)
- reverify-grok-prompting-citations — Forward-note: re-verify grok-prompting Part 1 citations if grok-code-fast-1 xAI docs page is ever pulled (2026-07-18T08:38Z)
