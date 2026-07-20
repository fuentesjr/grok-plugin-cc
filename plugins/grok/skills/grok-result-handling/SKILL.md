---
name: grok-result-handling
description: Internal guidance for presenting Grok companion output back to the user
user-invocable: false
---

# Grok Result Handling

When the helper returns Grok output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Grok marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Grok made edits, say so explicitly and list the touched files when the helper provides them.
- For `grok:grok-rescue`, do not turn a failed or incomplete Grok run into a Claude-side implementation attempt. Report the failure and stop.
- For `grok:grok-rescue`, if Grok was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Grok run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/grok:setup` and do not improvise alternate auth flows.

## Trust but verify

- Grok's claim of a green run (tests pass, task complete) is never sufficient on its own. After any write job, Claude re-runs the verification command itself and reports the actual result.
- Review findings from Grok are candidates, not conclusions. Check each finding against the actual code before surfacing it to the user; do not repeat a finding you could not confirm.
- Result reports must state three things explicitly: what Grok changed (diff summary), what Claude verified itself (command run and outcome), and anything skipped or left unverified.

## Failure handling

- If Grok errors or the stream is malformed, report the raw tail of the job log. Retry once, resuming the session, only if the failure looks transient (timeout, connection reset, truncated stream). Do not retry on a clear task or logic failure.
- If Grok claims success but Claude's own verification fails, do one feedback round on the same session with the failing output. If the second attempt also fails, stop and report — either fix the residue yourself or hand the diff back to the user. Do not loop further.
- If a job's budget expires, the productive turn is cancelled, a short wind-down handoff is requested, and the job is marked failed; report that as a budget expiry (not a generic error), surface any handoff text Grok wrote, and preserve the job log reference.
- If auth has expired, direct the user to `/grok:setup` and `grok login`. Do not improvise an alternate auth flow.
- **Interrupted / incomplete stream:** every rescue `task` is tracked. If stdout is only the `Tracked job <id> started` banner, freezes mid-turn, or has no final Grok answer, do **not** invent a substitute. Recover with `/grok:status <id>` and `/grok:result <id>`. Failed jobs may also have `jobs/<id>.dump.json` forensics (death kind, last progress, partial assistant text).
