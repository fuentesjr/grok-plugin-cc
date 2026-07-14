import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("command set includes adversarial-review but no transfer surface", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("review command drives the prompt-driven review runtime without native-reviewer or adversarial wording", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Grok Build's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--wait\|--background\] \[--base <ref>\] \[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/grok-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Grok review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
  assert.doesNotMatch(source, /native reviewer/i);
  assert.doesNotMatch(source, /adversarial/i);
  assert.doesNotMatch(source, /transfer/i);
});

test("rescue command routes through the grok-rescue subagent and absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/grok-rescue.md");
  const runtimeSkill = read("skills/grok-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Grok Build's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  assert.match(rescue, /subagent_type: "grok:grok-rescue"/);
  assert.match(rescue, /do not call `Skill\(grok:grok-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|fast>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Grok thread/);
  assert.match(rescue, /Start a new Grok thread/);
  assert.match(rescue, /run the `grok:grok-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /If they ask for `fast`, map it to `grok-composer-2\.5-fast`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Grok companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.doesNotMatch(rescue, /spark/i);
  assert.doesNotMatch(rescue, /codex/i);

  assert.match(agent, /name:\s*grok-rescue/);
  assert.match(agent, /model:\s*sonnet/);
  assert.match(agent, /tools:\s*Bash/);
  assert.match(agent, /skills:\s*\n\s*-\s*grok-cli-runtime/);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Grok Build running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `fast`, map that to `--model grok-composer-2\.5-fast`/i);
  assert.match(agent, /Return the stdout of the `grok-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Grok cannot be invoked, return nothing/i);
  assert.doesNotMatch(agent, /spark/i);
  assert.doesNotMatch(agent, /gpt-5-4-prompting/i);
  assert.doesNotMatch(agent, /codex/i);

  assert.match(runtimeSkill, /user-invocable:\s*false/);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `fast` to `--model grok-composer-2\.5-fast`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Grok cannot be invoked, return nothing/i);
  assert.doesNotMatch(runtimeSkill, /spark/i);
});

test("result-handling skill encodes trust-but-verify, result-report contract, and failure policy", () => {
  const resultHandling = read("skills/grok-result-handling/SKILL.md");

  assert.match(resultHandling, /user-invocable:\s*false/);
  assert.match(resultHandling, /do not turn a failed or incomplete Grok run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Grok was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(resultHandling, /CRITICAL: After presenting review findings, STOP/);
  assert.match(resultHandling, /Auto-applying fixes from a review is strictly forbidden/i);

  // Trust but verify (implementation-notes.md "Dispatch & result conventions")
  assert.match(resultHandling, /Trust but verify/i);
  assert.match(resultHandling, /Grok's claim of a green run.*is never sufficient/i);
  assert.match(resultHandling, /Claude re-runs the verification command itself/i);
  assert.match(resultHandling, /Review findings from Grok are candidates, not conclusions/i);
  assert.match(resultHandling, /what Grok changed \(diff summary\)/i);
  assert.match(resultHandling, /what Claude verified itself/i);
  assert.match(resultHandling, /anything skipped or left unverified/i);

  // Failure handling (implementation-notes.md "Failure handling")
  assert.match(resultHandling, /Failure handling/i);
  assert.match(resultHandling, /Retry once, resuming the session, only if the failure looks transient/i);
  assert.match(resultHandling, /do one feedback round on the same session with the failing output/i);
  assert.match(resultHandling, /if the second attempt also fails, stop and report/i);
  assert.match(resultHandling, /budget expires.*wind-down handoff.*marked failed/i);
  assert.match(resultHandling, /auth has expired, direct the user to `\/grok:setup` and `grok login`/i);
});

test("status, result, and cancel commands are deterministic passthrough entrypoints", () => {
  const status = read("commands/status.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");

  assert.match(status, /disable-model-invocation:\s*true/);
  assert.match(status, /grok-companion\.mjs" status "\$ARGUMENTS"/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /grok-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /grok-companion\.mjs" cancel "\$ARGUMENTS"/);
});

test("hooks keep session lifecycle wiring and add the opt-in Stop review gate", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
  assert.match(source, /"Stop"/);
  assert.match(source, /stop-review-gate-hook/);

  const parsed = JSON.parse(source);
  assert.deepEqual(Object.keys(parsed.hooks).sort(), ["SessionEnd", "SessionStart", "Stop"]);
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].timeout, 5);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].timeout, 5);
  assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 720);
});

test("setup command offers install and still points users at grok login", () => {
  const setup = read("commands/setup.md");

  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /grok-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /\(Recommended\)/);
  assert.match(setup, /!grok login/);
  assert.doesNotMatch(setup, /codex/i);
  assert.match(setup, /--enable-review-gate/);
  assert.match(setup, /--disable-review-gate/);
});

test("review-output schema matches the reference shape verbatim", () => {
  const schema = JSON.parse(read("schemas/review-output.schema.json"));

  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
  assert.deepEqual(schema.properties.findings.items.required, [
    "severity",
    "title",
    "body",
    "file",
    "line_start",
    "line_end",
    "confidence",
    "recommendation"
  ]);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, [
    "critical",
    "high",
    "medium",
    "low"
  ]);
});

test("review prompt carries the review-schema placeholders and no adversarial-review branding", () => {
  const reviewPrompt = read("prompts/review.md");

  assert.match(reviewPrompt, /\{\{TARGET_LABEL\}\}/);
  assert.match(reviewPrompt, /\{\{USER_FOCUS\}\}/);
  assert.match(reviewPrompt, /\{\{REVIEW_COLLECTION_GUIDANCE\}\}/);
  assert.match(reviewPrompt, /\{\{REVIEW_INPUT\}\}/);
  assert.match(reviewPrompt, /Return only valid JSON matching the provided schema/i);
  assert.doesNotMatch(reviewPrompt, /adversarial/i);
  assert.doesNotMatch(reviewPrompt, /codex/i);
});

test("task-brief prompt carries the brief placeholders", () => {
  const taskBrief = read("prompts/task-brief.md");

  assert.match(taskBrief, /\{\{CONTEXT\}\}/);
  assert.match(taskBrief, /\{\{TASK\}\}/);
  assert.match(taskBrief, /\{\{CONSTRAINTS\}\}/);
  assert.match(taskBrief, /\{\{ACCEPTANCE_CRITERIA\}\}/);
  assert.match(taskBrief, /\{\{VERIFICATION_COMMAND\}\}/);
});

test("setup command installer uses official x.ai curl invocation, not npm", () => {
  const setup = read("commands/setup.md");

  assert.match(setup, /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/);
  assert.doesNotMatch(setup, /npm install/i);
});

test("grok-rescue and grok-cli-runtime default to --write unless user asks for read-only", () => {
  const rescue = read("agents/grok-rescue.md");
  const runtime = read("skills/grok-cli-runtime/SKILL.md");

  assert.match(rescue, /Default to a write-capable Grok run by adding `--write`/);
  assert.match(runtime, /Default to a write-capable Grok run by adding `--write`/);
});

test("grok-prompting skill is honestly attributed, xAI-sourced, and free of other-vendor content", () => {
  const skill = read("skills/grok-prompting/SKILL.md");
  const reference = read("skills/grok-prompting/references/grok-prompt-guidance.md");
  const agent = read("agents/grok-rescue.md");

  // Wired into the rescue agent after grok-cli-runtime (keeps the skills-list assertion intact).
  assert.match(agent, /skills:\s*\n\s*-\s*grok-cli-runtime\s*\n\s*-\s*grok-prompting/);

  // Grounded in xAI's official docs, with real source links.
  assert.match(skill, /name:\s*grok-prompting/);
  assert.match(reference, /docs\.x\.ai/);

  // Honesty: xAI-official content is separated from general craft that is NOT claimed as xAI's.
  assert.match(reference, /xAI-official/i);
  assert.match(reference, /NOT attributed to xAI/i);

  // Zero cross-vendor / model-specific content lifted from elsewhere.
  for (const body of [skill, reference]) {
    assert.doesNotMatch(body, /\bgpt\b/i);
    assert.doesNotMatch(body, /codex/i);
    assert.doesNotMatch(body, /openai/i);
  }
});

test("hooks.json command strings contain CLAUDE_PLUGIN_ROOT for both SessionStart and SessionEnd", () => {
  const source = read("hooks/hooks.json");
  const parsed = JSON.parse(source);

  assert.match(parsed.hooks.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(parsed.hooks.SessionEnd[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test("LICENSE and NOTICE are duplicated byte-identical into the plugin directory", () => {
  const rootLicense = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  const rootNotice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
  const pluginLicense = read("LICENSE");
  const pluginNotice = read("NOTICE");

  assert.equal(pluginLicense, rootLicense);
  assert.equal(pluginNotice, rootNotice);
});
