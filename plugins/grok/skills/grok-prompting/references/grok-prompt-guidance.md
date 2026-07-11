# Grok prompting — sourced guidance

Two clearly separated sources: what **xAI officially documents** (attributed, with links),
and **general prompt craft** that is model-agnostic and is *not* claimed to be xAI guidance.
Nothing here is derived from any other vendor's model-specific advice.

## Part 1 — xAI-official guidance (attributed)

xAI's published, prompt-specific guidance lives in its *Prompt Engineering for Grok Code Fast 1*
guide. Grok Build (the CLI this plugin drives) defaults to `grok-4.5`, a different model, so treat
the **structural** points below as model-general and the **model-selection** point as specific to
the fast coding model. Every point here is xAI's own recommendation.

From **Prompt Engineering for Grok Code Fast 1**
(https://docs.x.ai/docs/guides/grok-code-prompt-engineering):

- **Front-load detailed context in the initial prompt.** The model is "accustomed to seeing a lot
  of context in the initial user prompt."
- **Mark up context with XML tags or Markdown headings.** xAI recommends using XML tags or
  Markdown-formatted headings to delimit sections of context so the model uses them effectively —
  "descriptive Markdown headings/XML tags and their corresponding definitions" improve use of context.
- **Write thorough system prompts.** "A well-written system prompt which describes the task,
  expectations, and edge-cases the model should be aware of can make a night-and-day difference."
- **Prefer native tool-calling over XML-based tool calls.** The model has first-party support for
  native tool-calling and "was specifically designed with native tool-calling in mind"; XML-based
  tool-call outputs "may hurt performance." (For this plugin, tool-calling is handled by the ACP
  runtime, so this is background, not something a task prompt should hand-roll.)
- **Iterate rapidly instead of over-engineering one prompt.** xAI "strongly suggests" refining the
  query by "adding more context or referencing the specific failures from the first attempt" rather
  than trying to write a perfect prompt up front.
- **Model selection (fast coding model only):** xAI positions grok-code-fast-1 for "agentic-style
  tasks rather than one-shot queries," and says its Grok 4 models "are more suited for one-shot Q&A."
  This is model-selection advice; do not over-apply it to grok-4.5-backed Grok Build.

From **Grok Build overview** (https://docs.x.ai/build/overview):

- Grok Build is "a powerful and extensible coding agent," usable via TUI, headless (`-p`), or ACP.
- xAI's own prompting examples are direct and concrete: "Explain this repo", and file-scoped asks
  like "@src/main.rs Walk me through this file." Concrete, targeted asks are the documented idiom.

From **Prompt caching best practices**
(https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices):

- Keep a **stable prefix**: place static content (system prompt, references) first, and **only
  append** new messages — editing, removing, or reordering earlier messages breaks the cache. This
  matters most for multi-turn / resumed sessions.

Not documented by xAI (an honest gap): xAI's general *Generate Text* guide
(https://docs.x.ai/docs/guides/chat) covers API mechanics, not prompt-quality best practices. There
is no official xAI "output-contract" or "verification-loop" prompt guidance — those live in Part 2.

## Part 2 — General prompt craft (model-agnostic, NOT attributed to xAI)

Standard prompting hygiene that applies to any capable model. Use it to fill the gaps xAI does not
document; do not present it as xAI's guidance.

- **One clear task per run.** Split unrelated asks into separate runs so the model does not
  interleave them.
- **State what "done" looks like.** Give an explicit end state and, where output is consumed by a
  tool, an exact output shape — do not rely on the model inferring the format.
- **Add grounding/verification only where wrong guesses are costly.** For review, research, or risky
  edits, require claims to be tied to evidence and say what to do when context is missing, rather
  than raising reasoning effort.
- **Prefer a tighter contract over a longer explanation.** When output drifts, sharpen the task and
  the output contract before adding prose or escalating effort.
- **On resume, send only the delta.** For a follow-up on the same session, state just the new
  instruction unless the direction changed materially (this also preserves the stable cache prefix
  xAI recommends).

## How this plugin already applies the above

The plugin's own prompts are the worked examples — read them before writing a fresh task prompt:

- `prompts/task-brief.md` — the rescue task contract (context, task, constraints, acceptance
  criteria, verification command). This *is* the "front-load context + state done" pattern.
- `prompts/review.md` / `prompts/adversarial-review.md` — the review contracts (structured output,
  grounding rules). Use these via `/grok:review` and `/grok:adversarial-review` for git-diff review
  instead of hand-writing a review prompt.
