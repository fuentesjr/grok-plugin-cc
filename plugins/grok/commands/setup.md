---
description: Check whether the local Grok Build CLI is ready and authenticated, and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If the result says Grok Build is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Grok Build now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Grok Build (Recommended)`
  - `Skip for now`
- If the user chooses install, run xAI's official installer (this pipes a remote script into `bash`, so expect a permission prompt — that confirmation is intentional):

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If Grok Build is already installed:
- Do not ask about installation.

Review-gate toggle:
- Pass `$ARGUMENTS` through verbatim; the companion parses `--enable-review-gate` / `--disable-review-gate`.
- `--enable-review-gate` turns on the opt-in Stop hook that runs a Grok review of the previous turn's edits before you can end the session; `--disable-review-gate` turns it back off. The gate is off by default and is the escape hatch if it ever stop-loops.
- Do not toggle the gate on the user's behalf unless they passed one of those flags.

Output rules:
- Present the final setup output to the user.
- If the setup output reports a review-gate action or its current status, surface that (enabled/disabled and for which workspace).
- If a Grok version-drift warning is present, surface it prominently with both versions and the read-only `/grok:rescue` re-verification guidance.
- If installation was skipped, present the original setup output.
- If Grok Build is installed but not authenticated, preserve the guidance to run `!grok login`.
