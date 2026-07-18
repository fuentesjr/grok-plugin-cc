# AGENTS.md — grok-plugin-cc operating rules

Claude Code plugin that delegates work to Grok Build over ACP. Decisions live
in `implementation-notes.md` and `docs/adr/`. Reference implementation:
`~/.claude/plugins/marketplaces/openai-codex/`.

## Work tracking

Work tracking lives in `.trk/` via the `trk` CLI. Orchestrator: run
`trk status --json` at session start; `trk dispatch` before spawning
long-running subagents and `trk resolve` on return; `trk check --strict`
before session end. Subagents: do not modify anything under `.trk/`; report
results in your final message.

## Standing process notes

- After changing plugin code, restart the broker or live runs exercise stale
  code.
- Bump the plugin version when changing the plugin surface (commands/hooks/
  skills) so marketplace update refreshes the installed snapshot.
- Dispatch codex **fresh** for runtime-coupled work (`--resume-last` does not
  resolve in this repo).
