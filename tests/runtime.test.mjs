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
import { loadState, resolveJobFile, upsertJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildEnv, installFakeGrok, readFakeGrokState } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));
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

test("setup --json reports happy-path, logged-out, and missing-binary states", async (t) => {
  await t.test("happy path", () => {
    const { binDir, cwd, env } = setupFake("task-ok");
    const payload = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
    assert.equal(payload.ready, true);
    assert.equal(payload.grok.available, true);
    assert.equal(payload.auth.loggedIn, true);
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
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA, PATH: binDir };
    const payload = jsonOutput(runCompanion(["setup", "--json", "-C", cwd], { cwd, env }));
    assert.equal(payload.ready, false);
    assert.equal(payload.grok.available, false);
    assert.match(payload.nextSteps.join("\n"), /Install Grok Build/);
  });
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

test("budget expiry marks a background job failed and preserves its log", async (t) => {
  const { cwd, env } = setupFake("hanging");
  t.after(() => cleanupBroker(cwd));

  const launch = jsonOutput(
    runCompanion(
      ["task", "--background", "--budget-ms", "60", "--json", "-C", cwd, "Exceed", "budget"],
      { cwd, env }
    )
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
  assert.deepEqual(await prompt, { stopReason: "cancelled" });
});

test("broker budget cancels a prompt after its client disconnects and broker/shutdown removes the socket", async (t) => {
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
      [BROKER_SESSION_META_KEY]: { access: "read-only", budgetMs: 60 }
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
