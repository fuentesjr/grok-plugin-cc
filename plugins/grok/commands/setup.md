---
description: Check whether the local Grok Build CLI is ready and authenticated
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

Output rules:
- Present the final setup output to the user.
- If a Grok version-drift warning is present, surface it prominently with both versions and the read-only `/grok:rescue` re-verification guidance.
- If installation was skipped, present the original setup output.
- If Grok Build is installed but not authenticated, preserve the guidance to run `!grok login`.
