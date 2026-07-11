---
name: grok-prompting
description: Internal guidance for composing effective Grok Build task and review prompts inside the Grok Companion plugin, grounded in xAI's official prompt guidance
user-invocable: false
---

# Grok prompting

Use this skill when `grok:grok-rescue` (or any Grok Companion dispatch) needs to shape a prompt for
Grok Build — a task brief, a diagnosis request, or a research ask.

The single most load-bearing move, per xAI's own guidance: **front-load rich context in the initial
prompt and mark it up with XML tags or Markdown headings**, then say exactly what "done" looks like.
Grok Build is designed for that. Reach for a tighter prompt contract before raising effort.

## Core rules

xAI-documented (see the reference for exact wording + links):
- Put detailed context up front; delimit sections with XML tags or Markdown headings.
- Write a thorough brief: task, expectations, and the edge-cases that matter.
- Be concrete and targeted — xAI's own examples are direct ("Explain this repo", "@path walk me
  through this file"), not vague.
- Iterate: refine by adding context or naming the specific failure from the last attempt, rather
  than polishing one perfect prompt.
- On a resumed session, only append the delta — reordering/editing earlier turns breaks Grok's
  prompt cache.

General craft (not xAI-specific, use to fill the gaps):
- One clear task per run; split unrelated asks.
- Give an explicit output shape when a tool consumes the result.
- Add grounding/verification rules only where an unsupported guess would hurt (review, research,
  risky edits).

## How to choose the prompt shape

- Reviewing local git changes → use `/grok:review` (defect/correctness) or
  `/grok:adversarial-review` (design challenge). Those prompts already carry the review contract;
  do not hand-roll one.
- Diagnosis, planning, research, or implementation → use `task` and control the prompt directly,
  following `prompts/task-brief.md` (context, task, constraints, acceptance criteria, verification
  command).
- Follow-up on the same thread → `task --resume-last` with only the new instruction.

## Assembly checklist

1. Front-load context, tagged/headed by section.
2. State the task and the exact end state ("done" = ...).
3. Choose the smallest output contract that keeps the result usable.
4. Add grounding/verification/safety rules only where the task needs them.
5. Cut anything the model does not need before sending.

Sourced guidance, exact xAI wording, and links live in
[references/grok-prompt-guidance.md](references/grok-prompt-guidance.md). It separates what xAI
officially documents from general model-agnostic craft; keep that line honest when you extend it.
