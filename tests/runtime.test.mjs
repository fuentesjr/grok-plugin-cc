import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROKER_BUSY_RPC_CODE,
  BROKER_SESSION_META_KEY,
  GrokAcpClient
} from "../plugins/grok/scripts/lib/acp-client.mjs";
import { parseBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/grok/scripts/lib/process.mjs";
import { loadState, resolveJobFile, setConfig, upsertJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildEnv, installFakeGrok, readFakeGrokState } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));
const STOP_HOOK = fileURLToPath(new URL("../plugins/grok/scripts/stop-review-gate-hook.mjs", import.meta.url));
const PLUGIN_DATA = makeTempDir("grok-runtime-state-");
const RUNTIME_DIR = "/private/tmp";

process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA;
process.env.GROK_COMPANION_RUNTIME_DIR = RUNTIME_DIR;

function runtimeEnv(binDir, overrides = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
    GROK_COMPANION_RUNTIME_DIR: RUNTIME_DIR,
    ...overrides
  });
}

function runScript(script, args, { cwd, env, input } = {}) {
  return run(process.execPath, [script, ...args], { cwd, env, input });
}

function runCompanion(args, { cwd, env, input } = {}) {
  return runScript(COMPANION, args, { cwd, env, input });
}

function jsonOutput(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function waitFor(predicate, timeoutMs = 8000, pollMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("Timed out waiting for runtime state.");
}

let unixSocketSupport;
async function supportsUnixSockets() {
  if (unixSocketSupport !== undefined) {
    return unixSocketSupport;
  }
  const socketPath = path.join(RUNTIME_DIR, `grok-runtime-probe-${process.pid}-${Date.now()}.sock`);
  unixSocketSupport = await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(socketPath, () => {
      server.close(() => {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
        resolve(true);
      });
    });
  });
  return unixSocketSupport;
}

async function requireUnixSockets(t) {
  if (await supportsUnixSockets()) {
    return true;
  }
  t.skip("local Unix sockets are blocked by the execution sandbox");
  return false;
}

async function cleanupBroker(cwd) {
  const broker = loadBrokerSession(cwd);
  if (!broker) {
    return;
  }
  await sendBrokerShutdown(broker.endpoint).catch(() => {});
  teardownBrokerSession({
    endpoint: broker.endpoint,
    pidFile: broker.pidFile,
    logFile: broker.logFile,
    sessionDir: broker.sessionDir,
    pid: broker.pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

function setupFake(behavior = "task-ok") {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, behavior);
  return { binDir, cwd, env: runtimeEnv(binDir) };
}

function runStopHook(cwd, env, input = {}) {
  return runScript(STOP_HOOK, [], {
    cwd,
    env,
    input: JSON.stringify({ session_id: "stop-session", cwd, last_assistant_message: "Implemented slice 2.", ...input })
  });
}

function writeStopReviewStub(source) {
  const scriptPath = path.join(makeTempDir("grok-stop-stub-"), "companion-stub.mjs");
  writeExecutable(scriptPath, source);
  return scriptPath;
}

test("setup --json reports happy-path, logged-out, and missing-binary states", async (t) => {
  await t.test("happy path", () => {
    const { binDir, cwd, env } = setupFake("task-ok");
    const payload = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
    assert.equal(payload.ready, true);
    assert.equal(payload.grok.available, true);
    assert.equal(payload.auth.loggedIn, true);
    assert.equal(Object.hasOwn(payload.auth, "requiresOpenaiAuth"), false);
  });

  await t.test("auth required", () => {
    const { cwd, env } = setupFake("auth-required");
    const payload = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
    assert.equal(payload.ready, false);
    assert.equal(payload.grok.available, true);
    assert.equal(payload.auth.loggedIn, false);
    assert.match(payload.nextSteps.join("\n"), /grok login/);
  });

  await t.test("missing binary", () => {
    const binDir = makeTempDir();
    const cwd = makeTempDir();
    writeExecutable(path.join(binDir, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    writeExecutable(path.join(binDir, "grok"), "#!/bin/sh\nexit 127\n");
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA, PATH: binDir };
    const payload = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
    assert.equal(payload.ready, false);
    assert.equal(payload.grok.available, false);
    assert.match(payload.nextSteps.join("\n"), /Install Grok Build/);
  });
});

test("setup stores verified Grok versions and reports one-time version drift", () => {
  const { binDir, cwd, env } = setupFake("task-ok");
  env.FAKE_GROK_VERSION = "grok 0.2.93";

  const first = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
  assert.equal(first.ready, true);
  assert.equal(first.versionDrift, null);
  assert.deepEqual(first.warnings, []);
  assert.equal(loadState(cwd).config.lastVerifiedGrokVersion, "grok 0.2.93");

  env.FAKE_GROK_VERSION = "grok 0.3.0";
  installFakeGrok(binDir, "auth-required");
  const failed = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
  assert.equal(failed.ready, false);
  assert.deepEqual(failed.versionDrift, {
    previous: "grok 0.2.93",
    current: "grok 0.3.0"
  });
  assert.match(failed.warnings.join("\n"), /last verified against grok 0\.2\.93/i);
  assert.match(failed.warnings.join("\n"), /\/grok:rescue/);
  assert.equal(loadState(cwd).config.lastVerifiedGrokVersion, "grok 0.2.93");

  const rendered = runCompanion(["setup", "-C", cwd], { cwd, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Version drift warning:/);
  assert.match(rendered.stdout, /grok 0\.2\.93/);
  assert.match(rendered.stdout, /grok 0\.3\.0/);
  assert.match(rendered.stdout, /\/grok:rescue/);

  installFakeGrok(binDir, "task-ok");
  const changed = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
  assert.equal(changed.ready, true);
  assert.deepEqual(changed.versionDrift, {
    previous: "grok 0.2.93",
    current: "grok 0.3.0"
  });
  assert.equal(loadState(cwd).config.lastVerifiedGrokVersion, "grok 0.3.0");

  const cleared = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
  assert.equal(cleared.versionDrift, null);
  assert.deepEqual(cleared.warnings, []);
});

test("setup toggles and reports the opt-in stop review gate", () => {
  const { cwd, env } = setupFake("task-ok");
  const enabled = jsonOutput(
    runCompanion(["setup", "--enable-review-gate", "--json", "-C", cwd], { cwd, env })
  );
  assert.equal(enabled.reviewGateEnabled, true);
  assert.equal(loadState(cwd).config.stopReviewGate, true);
  assert.match(enabled.actionsTaken.join("\n"), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const human = runCompanion(["setup", "-C", cwd], { cwd, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /stop review gate: enabled/i);

  const disabled = jsonOutput(
    runCompanion(["setup", "--disable-review-gate", "--json", "-C", cwd], { cwd, env })
  );
  assert.equal(disabled.reviewGateEnabled, false);
  assert.equal(loadState(cwd).config.stopReviewGate, false);
  assert.match(disabled.nextSteps.join("\n"), /--enable-review-gate/);

  const conflict = runCompanion(
    ["setup", "--enable-review-gate", "--disable-review-gate", "--json", "-C", cwd],
    { cwd, env }
  );
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Choose either --enable-review-gate or --disable-review-gate\./);
});

test("foreground task stores its result, job record, and progress log", async (t) => {
  const { cwd, env } = setupFake("task-ok");
  t.after(() => cleanupBroker(cwd));

  const payload = jsonOutput(
    runCompanion(["task", "--json", "-C", cwd, "Implement", "the", "change"], { cwd, env })
  );
  assert.equal(payload.status, 0);
  assert.equal(payload.rawOutput, "Task completed.");
  assert.ok(payload.jobId);

  const state = loadState(cwd);
  const job = state.jobs.find((candidate) => candidate.id === payload.jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.threadId, payload.threadId);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, payload.jobId), "utf8"));
  assert.equal(stored.result.rawOutput, "Task completed.");
  assert.equal(fs.existsSync(job.logFile), true);
  assert.match(fs.readFileSync(job.logFile, "utf8"), /Turn completed \(end_turn\)/);
});

test("background task completes through status --wait and result", async (t) => {
  const { cwd, env } = setupFake("task-ok");
  t.after(() => cleanupBroker(cwd));

  const launch = jsonOutput(
    runCompanion(["task", "--background", "--json", "-C", cwd, "Background", "task"], { cwd, env })
  );
  const snapshot = jsonOutput(
    runCompanion(
      ["status", launch.jobId, "--wait", "--json", "--timeout-ms", "8000", "--poll-interval-ms", "25", "-C", cwd],
      { cwd, env }
    )
  );
  assert.equal(snapshot.job.status, "completed");

  const result = jsonOutput(runCompanion(["result", launch.jobId, "--json", "-C", cwd], { cwd, env }));
  assert.equal(result.storedJob.result.rawOutput, "Task completed.");
  assert.equal(fs.existsSync(result.job.logFile), true);
});

test("cancel stops a hanging background task and preserves its log", async (t) => {
  const { cwd, env } = setupFake("hanging");
  t.after(() => cleanupBroker(cwd));

  const launch = jsonOutput(
    runCompanion(["task", "--background", "--json", "-C", cwd, "Hang"], { cwd, env })
  );
  await waitFor(() => {
    const job = loadState(cwd).jobs.find((candidate) => candidate.id === launch.jobId);
    return job?.status === "running" && job.threadId ? job : null;
  });

  const cancelled = jsonOutput(runCompanion(["cancel", launch.jobId, "--json", "-C", cwd], { cwd, env }));
  assert.equal(cancelled.status, "cancelled");
  const job = loadState(cwd).jobs.find((candidate) => candidate.id === launch.jobId);
  assert.equal(job.status, "cancelled");
  assert.equal(fs.existsSync(job.logFile), true);
  assert.match(fs.readFileSync(job.logFile, "utf8"), /Cancelled by user/);
});

test("status --wait timeout exits 2 with still-active job state, not a job failure", async (t) => {
  const { cwd, env } = setupFake("hanging");
  t.after(() => cleanupBroker(cwd));

  const launch = jsonOutput(
    runCompanion(["task", "--background", "--json", "-C", cwd, "Hang", "for", "wait"], { cwd, env })
  );
  await waitFor(() => {
    const job = loadState(cwd).jobs.find((candidate) => candidate.id === launch.jobId);
    return job?.status === "running" ? job : null;
  });

  const waited = runCompanion(
    [
      "status",
      launch.jobId,
      "--wait",
      "--json",
      "--timeout-ms",
      "80",
      "--poll-interval-ms",
      "20",
      "-C",
      cwd
    ],
    { cwd, env }
  );
  assert.equal(waited.status, 2, waited.stderr || waited.stdout);
  const payload = JSON.parse(waited.stdout);
  assert.equal(payload.waitTimedOut, true);
  assert.equal(payload.waitTimeoutMs, 80);
  assert.equal(payload.job.status, "running");
  assert.match(payload.error, /wait timeout, not a job failure/i);

  const stillRunning = loadState(cwd).jobs.find((candidate) => candidate.id === launch.jobId);
  assert.equal(stillRunning.status, "running");
});

test("default budget cancels a background job when no budget flag or public override is supplied", async (t) => {
  const { cwd, env } = setupFake("hanging");
  env.GROK_COMPANION_TEST_DEFAULT_BUDGET_MS = "60";
  t.after(() => cleanupBroker(cwd));

  const launch = jsonOutput(
    runCompanion(["task", "--background", "--json", "-C", cwd, "Exceed", "default", "budget"], {
      cwd,
      env
    })
  );
  const snapshot = jsonOutput(
    runCompanion(
      ["status", launch.jobId, "--wait", "--json", "--timeout-ms", "8000", "--poll-interval-ms", "25", "-C", cwd],
      { cwd, env }
    )
  );
  assert.equal(snapshot.job.status, "failed");
  assert.equal(fs.existsSync(snapshot.job.logFile), true);
  assert.match(fs.readFileSync(snapshot.job.logFile, "utf8"), /Turn cancelled|Budget expired/);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, launch.jobId), "utf8"));
  assert.equal(stored.request.budgetMs, 60);
});

test("background write refuses dirty trees and runs on a clean tree", async (t) => {
  const { cwd, env } = setupFake("task-ok");
  t.after(() => cleanupBroker(cwd));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");

  const refused = runCompanion(
    ["task", "--background", "--write", "--json", "-C", cwd, "Write", "change"],
    { cwd, env }
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /clean working tree/);
  assert.match(refused.stderr, /commit or stash|Commit or stash/);
  assert.match(refused.stderr, /--wait/);

  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "make clean"], { cwd });
  const launch = jsonOutput(
    runCompanion(
      ["task", "--background", "--write", "--json", "-C", cwd, "Write", "change"],
      { cwd, env }
    )
  );
  const snapshot = jsonOutput(
    runCompanion(
      ["status", launch.jobId, "--wait", "--json", "--timeout-ms", "8000", "--poll-interval-ms", "25", "-C", cwd],
      { cwd, env }
    )
  );
  assert.equal(snapshot.job.status, "completed");
  assert.equal(snapshot.job.write, true);
});

test("review returns parsed JSON and tolerates an invalid final message", async (t) => {
  async function runReviewBehavior(behavior) {
    const { cwd, env } = setupFake(behavior);
    t.after(() => cleanupBroker(cwd));
    initGitRepo(cwd);
    fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
    run("git", ["add", "app.js"], { cwd });
    run("git", ["commit", "-m", "init"], { cwd });
    fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
    return jsonOutput(
      runCompanion(["review", "--json", "--scope", "working-tree", "-C", cwd], { cwd, env })
    );
  }

  const valid = await runReviewBehavior("review-ok");
  assert.equal(valid.result.verdict, "approve");
  assert.equal(valid.parseError, null);

  const invalid = await runReviewBehavior("invalid-json");
  assert.equal(invalid.result, null);
  assert.match(invalid.parseError, /JSON/);
  assert.equal(invalid.rawOutput, "This is not JSON.");
});

test("adversarial-review accepts focus text while review still rejects it", async (t) => {
  const { binDir, cwd, env } = setupFake("review-ok");
  t.after(() => cleanupBroker(cwd));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");

  const payload = jsonOutput(
    runCompanion(
      [
        "adversarial-review",
        "--json",
        "--scope",
        "working-tree",
        "-C",
        cwd,
        "Challenge",
        "the",
        "module",
        "boundaries"
      ],
      { cwd, env }
    )
  );
  const job = JSON.parse(fs.readFileSync(resolveJobFile(cwd, payload.jobId), "utf8"));
  assert.equal(job.kind, "adversarial-review");
  assert.equal(job.jobClass, "review");
  assert.equal(job.title, "Grok Adversarial Review");
  assert.match(job.summary, /^Adversarial review /);
  const snapshot = jsonOutput(runCompanion(["status", payload.jobId, "--json", "-C", cwd], { cwd, env }));
  assert.equal(snapshot.job.kindLabel, "adversarial-review");
  const prompt = readFakeGrokState(binDir).prompts.at(-1).prompt[0].text;
  assert.match(prompt, /Challenge the module boundaries/);
  assert.doesNotMatch(prompt, /\{\{USER_FOCUS\}\}/);
  // Pin the companion -> adversarial-template wiring: assert content unique to
  // adversarial-review.md so dropping `promptName` (falling back to review.md,
  // which also interpolates USER_FOCUS) would fail here.
  assert.match(prompt, /design_attack_surface/);
  assert.doesNotMatch(prompt, /<attack_surface>/);

  const rejected = runCompanion(
    ["review", "--json", "--scope", "working-tree", "-C", cwd, "custom", "focus"],
    { cwd, env }
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /`\/grok:review` does not accept custom focus text\./);
});

test("task-resume-candidate changes from unavailable to available after a task", async (t) => {
  const { cwd, env } = setupFake("task-ok");
  t.after(() => cleanupBroker(cwd));

  const before = jsonOutput(runCompanion(["task-resume-candidate", "--json", "-C", cwd], { cwd, env }));
  assert.equal(before.available, false);
  jsonOutput(runCompanion(["task", "--json", "-C", cwd, "First", "task"], { cwd, env }));
  const after = jsonOutput(runCompanion(["task-resume-candidate", "--json", "-C", cwd], { cwd, env }));
  assert.equal(after.available, true);
  assert.ok(after.candidate.threadId);
});

test("stop-review dispatch is excluded from resume state and does not persist the thread", async (t) => {
  const { binDir, cwd, env } = setupFake("stop-allow");
  t.after(() => cleanupBroker(cwd));

  const gate = jsonOutput(
    runCompanion(["stop-review-task", "--json", "--budget-ms", "480000", "Review", "the", "turn"], {
      cwd,
      env
    })
  );
  assert.equal(gate.rawOutput, "ALLOW: no blocking issue found");
  const stateAfterGate = loadState(cwd);
  const gateJob = stateAfterGate.jobs.find((job) => job.id === gate.jobId);
  assert.equal(gateJob.jobClass, "stop-review");
  assert.equal(stateAfterGate.lastTaskSession, null);
  const noCandidate = jsonOutput(
    runCompanion(["task-resume-candidate", "--json", "-C", cwd], { cwd, env })
  );
  assert.equal(noCandidate.available, false);

  jsonOutput(runCompanion(["task", "--json", "-C", cwd, "Persistent", "task"], { cwd, env }));
  const persisted = loadState(cwd).lastTaskSession;
  jsonOutput(
    runCompanion(["stop-review-task", "--json", "--budget-ms", "480000", "Review", "again"], {
      cwd,
      env
    })
  );
  assert.deepEqual(loadState(cwd).lastTaskSession, persisted);
  const candidate = jsonOutput(
    runCompanion(["task-resume-candidate", "--json", "-C", cwd], { cwd, env })
  );
  assert.equal(candidate.available, true);
  assert.notEqual(candidate.candidate.id, gate.jobId);
  const agentSpawns = readFakeGrokState(binDir).spawns.filter((entry) => entry.mode === "agent");
  assert.equal(agentSpawns.every((entry) => entry.model == null && entry.effort == null), true);
});

test("Stop hook fail-open preconditions do not dispatch a review", async (t) => {
  await t.test("gate off", () => {
    const { binDir, cwd, env } = setupFake("stop-block");
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(readFakeGrokState(binDir), null);
  });

  await t.test("Grok unavailable", () => {
    const binDir = makeTempDir();
    const cwd = makeTempDir();
    writeExecutable(path.join(binDir, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    writeExecutable(path.join(binDir, "grok"), "#!/bin/sh\nexit 127\n");
    const env = runtimeEnv(binDir);
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not set up.*\/grok:setup/i);
  });

  await t.test("live running job", () => {
    const { binDir, cwd, env } = setupFake("stop-block");
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    t.after(() => worker.kill());
    setConfig(cwd, "stopReviewGate", true);
    upsertJob(cwd, {
      id: "live-task",
      sessionId: "stop-session",
      jobClass: "task",
      status: "running",
      pid: worker.pid,
      startedAt: new Date().toISOString()
    });
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Grok task live-task is still running/);
    assert.equal(readFakeGrokState(binDir).prompts.length, 0);
  });
});

test("Stop hook reviews stale running records and applies ALLOW/BLOCK verdicts", async (t) => {
  await t.test("dead PID does not suppress an ALLOW review", async () => {
    const { binDir, cwd, env } = setupFake("stop-allow");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    upsertJob(cwd, {
      id: "stale-task",
      sessionId: "stop-session",
      jobClass: "task",
      status: "running",
      pid: 2_147_483_647,
      startedAt: new Date().toISOString()
    });
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const prompt = readFakeGrokState(binDir).prompts.at(-1).prompt[0].text;
    assert.match(prompt, /Previous Claude response:\nImplemented slice 2\./);
    assert.doesNotMatch(prompt, /\{\{CLAUDE_RESPONSE_BLOCK\}\}/);
  });

  await t.test("null-pid running job within the age cutoff suppresses the review", () => {
    const { binDir, cwd, env } = setupFake("stop-allow");
    setConfig(cwd, "stopReviewGate", true);
    upsertJob(cwd, {
      id: "fresh-nopid-task",
      sessionId: "stop-session",
      jobClass: "task",
      status: "running",
      pid: null,
      startedAt: new Date().toISOString()
    });
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Grok task fresh-nopid-task is still running/);
    assert.equal(readFakeGrokState(binDir).prompts.length, 0);
  });

  await t.test("null-pid running job past the age cutoff is treated as stale and reviewed", async () => {
    const { binDir, cwd, env } = setupFake("stop-allow");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    // A crashed worker stops advancing updatedAt, so the newest timestamp goes stale.
    const thirteenMinutesAgo = new Date(Date.now() - 13 * 60 * 1000).toISOString();
    upsertJob(cwd, {
      id: "stale-nopid-task",
      sessionId: "stop-session",
      jobClass: "task",
      status: "running",
      pid: null,
      createdAt: thirteenMinutesAgo,
      updatedAt: thirteenMinutesAgo,
      startedAt: thirteenMinutesAgo
    });
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(readFakeGrokState(binDir).prompts.length, 1);
  });

  await t.test("BLOCK verdict emits a block decision", async () => {
    const { cwd, env } = setupFake("stop-block");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /tests are still failing/);
  });

  await t.test("empty final output blocks", async () => {
    const { cwd, env } = setupFake("empty-output");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, "block");
    assert.match(JSON.parse(result.stdout).reason, /no final output/i);
  });

  await t.test("preamble-shifted ALLOW verdict still allows", async () => {
    const { cwd, env } = setupFake("stop-preamble-allow");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  await t.test("preamble-shifted BLOCK verdict blocks with a clean reason", async () => {
    const { cwd, env } = setupFake("stop-preamble-block");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /sufficient-funds guard and can overdraft/);
    // The preamble sentence must NOT leak into the reason relayed to the user.
    assert.doesNotMatch(decision.reason, /I'll check the previous turn/);
  });

  await t.test("both distinct verdict tokens are ambiguous and fail closed", async () => {
    const { cwd, env } = setupFake("stop-both-tokens");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, "block");
  });

  await t.test("DISALLOW substring is not a verdict token and fails closed", async () => {
    const { cwd, env } = setupFake("stop-disallow-only");
    t.after(() => cleanupBroker(cwd));
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, "block");
  });
});

test("Stop hook classifies dispatch failures and structured broker busy correctly", async (t) => {
  const cases = [
    {
      name: "structured broker busy allows",
      source: 'process.stdout.write(JSON.stringify({ brokerBusy: true, status: "broker-busy" }));',
      expectedDecision: null
    },
    {
      name: "non-zero exit blocks",
      source: 'process.stderr.write("dispatch exploded\\n"); process.exitCode = 7;',
      expectedDecision: "block",
      reason: /dispatch exploded/
    },
    {
      name: "invalid JSON blocks",
      source: 'process.stdout.write("not-json\\n");',
      expectedDecision: "block",
      reason: /invalid JSON/i
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const { cwd, env } = setupFake("stop-allow");
      setConfig(cwd, "stopReviewGate", true);
      const result = runStopHook(cwd, {
        ...env,
        GROK_COMPANION_TEST_STOP_REVIEW_SCRIPT: writeStopReviewStub(testCase.source)
      });
      assert.equal(result.status, 0, result.stderr);
      if (testCase.expectedDecision == null) {
        assert.equal(result.stdout, "");
      } else {
        const decision = JSON.parse(result.stdout);
        assert.equal(decision.decision, testCase.expectedDecision);
        assert.match(decision.reason, testCase.reason);
      }
    });
  }

  await t.test("subprocess timeout blocks", () => {
    const { cwd, env } = setupFake("stop-allow");
    setConfig(cwd, "stopReviewGate", true);
    const result = runStopHook(cwd, {
      ...env,
      GROK_COMPANION_TEST_STOP_REVIEW_SCRIPT: writeStopReviewStub("setInterval(() => {}, 1000);"),
      GROK_COMPANION_STOP_REVIEW_TIMEOUT_MS: "100"
    });
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /timed out after 10 minutes/i);
  });
});

test("broker routes read and write sessions to separate sandbox-profile children", async (t) => {
  if (!(await requireUnixSockets(t))) {
    return;
  }
  const { binDir, cwd, env } = setupFake("task-ok");
  t.after(() => cleanupBroker(cwd));

  jsonOutput(runCompanion(["task", "--json", "-C", cwd, "Read", "task"], { cwd, env }));
  jsonOutput(runCompanion(["task", "--write", "--json", "-C", cwd, "Write", "task"], { cwd, env }));

  const state = readFakeGrokState(binDir);
  const profiles = state.spawns.filter((entry) => entry.mode === "agent").map((entry) => entry.sandboxProfile);
  assert.deepEqual([...new Set(profiles)].sort(), ["read-only", "workspace"]);
  assert.equal(state.sessions.some((session) => session.sandboxProfile === "read-only"), true);
  assert.equal(state.sessions.some((session) => session.sandboxProfile === "workspace"), true);
  assert.equal(state.sessions.every((session) => session.meta?.[BROKER_SESSION_META_KEY] === undefined), true);
  assert.equal(state.sessions.every((session) => /git commit/.test(session.rules)), true);
});

test("broker enforces busy-lock while always admitting session/cancel", async (t) => {
  if (!(await requireUnixSockets(t))) {
    return;
  }
  const { binDir, cwd, env } = setupFake("hanging");
  const broker = await ensureBrokerSession(cwd, { env, timeoutMs: 5000 });
  assert.ok(broker);
  t.after(() => cleanupBroker(cwd));

  const first = await GrokAcpClient.connect(cwd, {
    brokerEndpoint: broker.endpoint,
    brokerFallback: false,
    env
  });
  const second = await GrokAcpClient.connect(cwd, {
    brokerEndpoint: broker.endpoint,
    brokerFallback: false,
    env
  });
  t.after(() => first.close().catch(() => {}));
  t.after(() => second.close().catch(() => {}));

  const session = await first.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: {
      rules: "stay in workspace",
      [BROKER_SESSION_META_KEY]: { access: "read-only" }
    }
  });
  const prompt = first.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "hang" }]
  });
  await waitFor(() => readFakeGrokState(binDir)?.prompts?.length === 1);

  await assert.rejects(
    second.request("session/new", { cwd, mcpServers: [] }),
    (error) => error.rpcCode === BROKER_BUSY_RPC_CODE
  );
  second.notify("session/cancel", { sessionId: session.sessionId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFakeGrokState(binDir).cancellations.length, 0);
  first.notify("session/cancel", { sessionId: session.sessionId });
  assert.deepEqual(await prompt, { stopReason: "cancelled" });
});

test("stop-review dispatch returns structured broker busy without direct fallback", async (t) => {
  if (!(await requireUnixSockets(t))) {
    return;
  }
  const { binDir, cwd, env } = setupFake("hanging");
  const broker = await ensureBrokerSession(cwd, { env, timeoutMs: 5000 });
  assert.ok(broker);
  t.after(() => cleanupBroker(cwd));
  const owner = await GrokAcpClient.connect(cwd, {
    brokerEndpoint: broker.endpoint,
    brokerFallback: false,
    env
  });
  t.after(() => owner.close().catch(() => {}));
  const session = await owner.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: { [BROKER_SESSION_META_KEY]: { access: "read-only" } }
  });
  const prompt = owner.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "hang" }]
  });
  await waitFor(() => readFakeGrokState(binDir)?.prompts?.length === 1);

  const result = runCompanion(
    ["stop-review-task", "--json", "--budget-ms", "480000", "Review", "the", "turn"],
    { cwd, env }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.brokerBusy, true);
  assert.equal(payload.status, "broker-busy");
  assert.equal(readFakeGrokState(binDir).spawns.filter((entry) => entry.mode === "agent").length, 1);

  owner.notify("session/cancel", { sessionId: session.sessionId });
  assert.deepEqual(await prompt, { stopReason: "cancelled" });
});

test("broker disconnect cancels the orphaned prompt and releases busy ownership", async (t) => {
  if (!(await requireUnixSockets(t))) {
    return;
  }
  const { binDir, cwd, env } = setupFake("hanging");
  t.after(() => cleanupBroker(cwd));
  const broker = await ensureBrokerSession(cwd, { env, timeoutMs: 5000 });
  assert.ok(broker);
  const client = await GrokAcpClient.connect(cwd, {
    brokerEndpoint: broker.endpoint,
    brokerFallback: false,
    env
  });
  const session = await client.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: {
      rules: "stay in workspace",
      [BROKER_SESSION_META_KEY]: { access: "read-only", budgetMs: 5000 }
    }
  });
  const prompt = client
    .request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hang" }]
    })
    .catch(() => null);
  await waitFor(() => readFakeGrokState(binDir)?.prompts?.length === 1);
  await client.close();
  await prompt;
  await waitFor(() => readFakeGrokState(binDir)?.cancellations?.length === 1);

  const nextClient = await GrokAcpClient.connect(cwd, {
    brokerEndpoint: broker.endpoint,
    brokerFallback: false,
    env
  });
  const nextSession = await nextClient.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: { [BROKER_SESSION_META_KEY]: { access: "read-only" } }
  });
  assert.ok(nextSession.sessionId);
  await nextClient.close();

  await sendBrokerShutdown(broker.endpoint);
  const target = parseBrokerEndpoint(broker.endpoint);
  if (target.kind === "unix") {
    await waitFor(() => !fs.existsSync(target.path));
  }
  teardownBrokerSession({
    endpoint: broker.endpoint,
    pidFile: broker.pidFile,
    logFile: broker.logFile,
    sessionDir: broker.sessionDir,
    pid: broker.pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
});

test("SessionStart exports shell-escaped session state", () => {
  const { cwd, env } = setupFake("task-ok");
  const envFile = path.join(makeTempDir(), "claude.env");
  const start = runScript(HOOK, ["SessionStart"], {
    cwd,
    env: { ...env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({ session_id: "session-'quoted", transcript_path: "/tmp/transcript-'quoted.jsonl" })
  });
  assert.equal(start.status, 0, start.stderr);
  const exports = fs.readFileSync(envFile, "utf8");
  assert.match(exports, /GROK_COMPANION_SESSION_ID/);
  assert.match(exports, /GROK_COMPANION_TRANSCRIPT_PATH/);
  assert.match(exports, /CLAUDE_PLUGIN_DATA/);
  assert.match(exports, /'"'"'/);
});

test("SessionEnd kills running jobs and removes jobs for the ending session", async (t) => {
  const { cwd, env } = setupFake("task-ok");
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  worker.unref();
  t.after(() => {
    try {
      terminateProcessTree(worker.pid);
    } catch {
      // Already stopped by the hook.
    }
  });
  upsertJob(cwd, {
    id: "session-job",
    sessionId: "ending-session",
    status: "running",
    pid: worker.pid,
    createdAt: new Date().toISOString()
  });

  const end = runScript(HOOK, ["SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ session_id: "ending-session", cwd })
  });
  assert.equal(end.status, 0, end.stderr);
  assert.equal(loadState(cwd).jobs.some((job) => job.id === "session-job"), false);
  await waitFor(() => {
    try {
      process.kill(worker.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("SessionEnd shuts down and clears the persisted broker", async (t) => {
  if (!(await requireUnixSockets(t))) {
    return;
  }
  const { cwd, env } = setupFake("task-ok");
  t.after(() => cleanupBroker(cwd));
  const broker = await ensureBrokerSession(cwd, { env, timeoutMs: 5000 });
  assert.ok(broker);
  const end = runScript(HOOK, ["SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ session_id: "ending-session", cwd })
  });
  assert.equal(end.status, 0, end.stderr);
  assert.equal(loadBrokerSession(cwd), null);
  const target = parseBrokerEndpoint(broker.endpoint);
  if (target.kind === "unix") {
    assert.equal(fs.existsSync(target.path), false);
  }
});
