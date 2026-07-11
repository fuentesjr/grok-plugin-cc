import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CONTINUE_PROMPT,
  buildPersistentTaskThreadName,
  findLatestTaskThread,
  getGrokAuthStatus,
  parseStructuredOutput,
  runAcpReview,
  runAcpTurn
} from "../plugins/grok/scripts/lib/grok.mjs";
import { enrichJob, readJobProgressPreview } from "../plugins/grok/scripts/lib/job-control.mjs";
import { buildEnv, installFakeGrok, readFakeGrokState } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-runtime-test-state-");

function setupFake(behavior) {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, behavior);
  return { binDir, cwd, env: buildEnv(binDir) };
}

test("runAcpTurn captures ACP updates and emits lockstep progress events", async () => {
  const { binDir, cwd, env } = setupFake("task-ok");
  const progress = [];
  const result = await runAcpTurn(cwd, {
    prompt: "Implement the change",
    env,
    disableBroker: true,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.status, 0);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.finalMessage, "Task completed.");
  assert.deepEqual(result.reasoningSummary, ["Inspecting the workspace."]);
  assert.equal(result.threadId, "session_1");
  assert.equal(result.turnId, null);
  assert.deepEqual(
    progress.map((event) => event.message),
    [
      "Starting Grok task session.",
      "Session ready (session_1).",
      "Turn started.",
      "Reasoning: Inspecting the workspace.",
      "Plan updated: Inspect and verify.",
      "Running command: Run tests.",
      "Command completed: Run tests.",
      "Assistant message captured: Task completed.",
      "Turn completed (end_turn)."
    ]
  );
  assert.ok(progress.every((event) => Object.hasOwn(event, "logBody")));

  const state = readFakeGrokState(binDir);
  assert.equal(state.spawns.find((spawn) => spawn.mode === "agent").sandboxProfile, "read-only");
  assert.match(state.sessions[0].rules, /git commit/);
  assert.match(state.sessions[0].rules, /git push/);
  assert.match(state.sessions[0].rules, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runAcpTurn accumulates multi-chunk ACP messages", async () => {
  const { cwd, env } = setupFake("streaming");
  const result = await runAcpTurn(cwd, {
    prompt: "Stream",
    env,
    disableBroker: true
  });

  assert.equal(result.finalMessage, "Streamed answer complete.");
});

test("runAcpTurn reports realistic write events once and ignores read_file", async () => {
  const { cwd, env } = setupFake("write-turn");
  const result = await runAcpTurn(cwd, {
    prompt: "Write the probe",
    env,
    disableBroker: true,
    sandbox: "workspace-write"
  });

  assert.deepEqual(result.touchedFiles, ["/abs/path/probe.txt"]);
  assert.ok(!result.touchedFiles.includes("/abs/path/read-only.txt"));
});

test("runAcpTurn cancels a hanging prompt when its wall-clock budget expires", async () => {
  const { binDir, cwd, env } = setupFake("hanging");
  const result = await runAcpTurn(cwd, {
    prompt: "Hang",
    env,
    disableBroker: true,
    budgetMs: 40
  });

  assert.equal(result.status, 1);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.budgetExpired, true);
  assert.equal(readFakeGrokState(binDir).cancellations.length, 1);
});

test("model and effort overrides force direct spawn with workspace sandbox routing", async () => {
  const { binDir, cwd, env } = setupFake("task-ok");
  await runAcpTurn(cwd, {
    prompt: "Write",
    env: { ...env, GROK_COMPANION_ACP_ENDPOINT: "unix:/definitely-missing-grok-broker.sock" },
    model: "fast",
    effort: "high",
    sandbox: "workspace-write"
  });

  const spawn = readFakeGrokState(binDir).spawns.find((candidate) => candidate.mode === "agent");
  assert.equal(spawn.sandboxProfile, "workspace");
  assert.equal(spawn.model, "grok-composer-2.5-fast");
  assert.equal(spawn.effort, "high");
  assert.deepEqual(spawn.args, [
    "--sandbox",
    "workspace",
    "agent",
    "--model",
    "grok-composer-2.5-fast",
    "--reasoning-effort",
    "high",
    "--no-leader",
    "--always-approve",
    "stdio"
  ]);
});

test("runAcpReview parses strict review JSON and tolerates invalid JSON", async () => {
  const valid = setupFake("review-ok");
  const validResult = await runAcpReview(valid.cwd, {
    targetLabel: "working tree diff",
    reviewInput: "diff --git a/app.js b/app.js",
    env: valid.env,
    disableBroker: true
  });
  assert.equal(validResult.result.parsed.verdict, "approve");
  assert.equal(validResult.result.parseError, null);

  const invalid = setupFake("invalid-json");
  const invalidResult = await runAcpReview(invalid.cwd, {
    targetLabel: "working tree diff",
    reviewInput: "diff",
    env: invalid.env,
    disableBroker: true
  });
  assert.equal(invalidResult.result.parsed, null);
  assert.match(invalidResult.result.parseError, /JSON/);
  assert.equal(invalidResult.result.rawOutput, "This is not JSON.");
});

test("parseStructuredOutput tolerates fenced JSON while preserving the raw message", () => {
  const rawOutput = "```json\n{\"verdict\":\"approve\"}\n```";
  const result = parseStructuredOutput(rawOutput);

  assert.deepEqual(result.parsed, { verdict: "approve" });
  assert.equal(result.parseError, null);
  assert.equal(result.rawOutput, rawOutput);
});

test("getGrokAuthStatus recognizes auth-required ACP errors", async () => {
  const { cwd, env } = setupFake("auth-required");
  const status = await getGrokAuthStatus(cwd, { env, disableBroker: true });

  assert.equal(status.available, true);
  assert.equal(status.loggedIn, false);
  assert.equal(status.source, "acp");
  assert.match(status.detail, /grok login/i);
});

test("runAcpTurn surfaces the fake CLI's raw stderr tail on spawn failure", async () => {
  const { cwd, env } = setupFake("spawn-fail");

  await assert.rejects(
    runAcpTurn(cwd, {
      prompt: "Fail during spawn",
      env,
      disableBroker: true
    }),
    /Raw Grok stderr tail:\nfake grok raw failure tail: agent process could not start/
  );
});

test("persistent task resume seeds a new ACP session from stored context", async () => {
  const { binDir, cwd, env } = setupFake("task-ok");
  const threadName = buildPersistentTaskThreadName("Implement durable resume");
  const first = await runAcpTurn(cwd, {
    prompt: "Implement durable resume",
    persistThread: true,
    threadName,
    env,
    disableBroker: true
  });
  const latest = await findLatestTaskThread(cwd);
  assert.deepEqual(latest, { id: first.threadId, name: threadName });

  const second = await runAcpTurn(cwd, {
    resumeThreadId: first.threadId,
    defaultPrompt: DEFAULT_CONTINUE_PROMPT,
    persistThread: true,
    env,
    disableBroker: true
  });
  assert.notEqual(second.threadId, first.threadId);

  const state = readFakeGrokState(binDir);
  const resumedPrompt = state.prompts.at(-1).prompt[0].text;
  assert.match(resumedPrompt, new RegExp(first.threadId));
  assert.match(resumedPrompt, /Continue from the prior task context/);
  assert.match(resumedPrompt, /Task completed\./);
});

test("job-control phase inference and block filtering stay in lockstep with ACP progress wording", () => {
  const cases = [
    ["Starting Grok task session.", "starting"],
    ["Session ready (session_1).", "starting"],
    ["Reasoning: Inspecting the workspace.", "investigating"],
    ["Plan updated: Inspect and verify.", "investigating"],
    ["Running command: npm test.", "verifying"],
    ["Command completed: npm test.", "verifying"],
    ["Assistant message captured: Done.", "finalizing"],
    ["Budget expired; cancelling turn.", "cancelling"],
    ["Turn cancelled.", "cancelled"],
    ["Grok error: failed to prompt", "failed"]
  ];

  for (const [message, expectedPhase] of cases) {
    const logFile = path.join(makeTempDir(), "job.log");
    fs.writeFileSync(logFile, `[2026-07-10T00:00:00.000Z] ${message}\n`, "utf8");
    const job = enrichJob({ status: "running", jobClass: "task", logFile });
    assert.equal(job.phase, expectedPhase, message);
  }

  const blockLog = path.join(makeTempDir(), "blocks.log");
  fs.writeFileSync(
    blockLog,
    [
      "[2026-07-10T00:00:00.000Z] Plan",
      "Inspect and verify",
      "[2026-07-10T00:00:01.000Z] Tool Run tests output",
      "tests passed",
      "[2026-07-10T00:00:02.000Z] Session ready (session_1)."
    ].join("\n"),
    "utf8"
  );
  assert.deepEqual(readJobProgressPreview(blockLog), ["Session ready (session_1)."]);
});
