---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code
user-invocable: false
---

# Grok Runtime

Use this skill only inside the `grok:grok-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "<raw arguments>"`

## Tracked jobs (read this first)

**Every `task` run is a tracked companion job.** This is not optional.

| Fact | Detail |
| --- | --- |
| Job registry | Companion writes `jobs/<id>.json` + `jobs/<id>.log` under the workspace state dir |
| Default `task` | Detached worker **+ wait** for the final result (survives parent/Bash kill) |
| Job id banner | First stdout line is `Tracked job <id> started. Recover with: /grok:status <id> …` |
| Progress | `/grok:status <id>` (or `/grok:status`) |
| Final output | `/grok:result <id>` |
| Cancel | `/grok:cancel <id>` |
| Crash / kill | Job keeps log + `jobs/<id>.dump.json` forensics (death kind, last progress, partial assistant text when known) |

If the Bash stream freezes, returns early, or has no final Grok answer, the turn is **not** necessarily lost: use the job id from the banner and run status/result. Do not invent a substitute answer.

Claude-side `/grok:rescue --background` / `--wait` only control whether the **subagent** is backgrounded in Claude Code. They are **not** the companion job system. Strip them before `task`; companion tracking still applies.

## Execution rules

- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged (including the tracked-job banner).
- Prefer the helper over hand-rolled `git`, direct Grok CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `status`, `result`, or `cancel` from `grok:grok-rescue` (the parent/user recovers via those commands if the wait is interrupted).
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `fast` to `--model grok-composer-2.5-fast`.
- Default to a write-capable Grok run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

## Command selection

- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- Do **not** pass companion `--background` from rescue. Default `task` already uses a detached tracked worker + wait (the reliability path). Fire-and-forget companion `--background` is for explicit user background launches outside this forwarder.
- If the forwarded request includes `--model`, normalize `fast` to `grok-composer-2.5-fast` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

## Safety rules

- Default to write-capable Grok work in `grok:grok-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is (banner + final output).
- If the Bash call fails or Grok cannot be invoked, return nothing.
