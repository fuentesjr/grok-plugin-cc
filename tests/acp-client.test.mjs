import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp-client.mjs";
import {
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown
} from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { buildEnv, installFakeGrok, readFakeGrokState } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

async function waitForState(binDir, predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = readFakeGrokState(binDir);
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake Grok state.");
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    assert.fail(`Expected valid JSON: ${error.message}\n${value}`);
  }
}

async function startWrongBroker(t) {
  const socketPath = path.join(makeTempDir(), "codex-broker.sock");
  const methods = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        const message = parseJson(line);
        methods.push(message.method);
        if (message.method === "initialize") {
          socket.write(
            `${JSON.stringify({
              id: message.id,
              result: { protocolVersion: 1, _meta: { broker: "codex-companion" } }
            })}\n`
          );
        } else {
          socket.write(
            `${JSON.stringify({
              id: message.id,
              error: { code: -32602, message: "unknown variant `session/new`, expected `thread/start`" }
            })}\n`
          );
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `unix:${socketPath}`, methods };
}

test("GrokAcpClient performs the verified ACP handshake and creates a session", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const client = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 15000
  });

  try {
    const session = await client.request("session/new", { cwd, mcpServers: [], _meta: { rules: "stay safe" } });
    assert.equal(session.sessionId, "session_1");
  } finally {
    await client.close();
  }

  const state = readFakeGrokState(binDir);
  assert.deepEqual(state.initializations[0], {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
  });
  assert.equal(state.sessions[0].cwd, cwd);
  assert.equal(state.sessions[0].rules, "stay safe");
});

test("GrokAcpClient rejects a persisted Codex broker and falls back to Grok directly", async (t) => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const wrongBroker = await startWrongBroker(t);
  saveBrokerSession(cwd, { endpoint: wrongBroker.endpoint });

  const client = await GrokAcpClient.connect(cwd, {
    reuseExistingBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 15000
  });

  try {
    assert.equal(client.transport, "direct");
    const session = await client.request("session/new", { cwd, mcpServers: [] });
    assert.equal(session.sessionId, "session_1");
  } finally {
    await client.close();
  }

  assert.deepEqual(wrongBroker.methods, ["initialize"]);
  assert.equal(loadBrokerSession(cwd), null);
});

test("sendBrokerShutdown does not stop a foreign broker", async (t) => {
  const wrongBroker = await startWrongBroker(t);

  assert.equal(await sendBrokerShutdown(wrongBroker.endpoint), false);
  assert.deepEqual(wrongBroker.methods, ["initialize"]);
});

test("GrokAcpClient dispatches notifications and cancels an in-flight prompt", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "hanging");
  const client = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 15000
  });

  try {
    const { sessionId } = await client.request("session/new", { cwd, mcpServers: [] });
    const prompt = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "wait" }]
    });
    await waitForState(binDir, (state) => state.prompts.length === 1);
    client.notify("session/cancel", { sessionId });
    assert.deepEqual(await prompt, { stopReason: "cancelled" });
  } finally {
    await client.close();
  }

  assert.equal(readFakeGrokState(binDir).cancellations.length, 1);
});

test("GrokAcpClient surfaces a direct-spawn failure with the raw stderr tail", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "spawn-fail");

  await assert.rejects(
    GrokAcpClient.connect(cwd, {
      disableBroker: true,
      env: buildEnv(binDir),
      requestTimeoutMs: 15000
    }),
    /fake grok raw failure tail: agent process could not start/
  );
});

test("session/prompt is not constrained by the flat request timeout", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "delayed");
  const client = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 100,
    initializeTimeoutMs: 15000
  });

  try {
    const { sessionId } = await client.request("session/new", { cwd, mcpServers: [] });
    const result = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "finish after the flat timeout" }]
    });
    assert.deepEqual(result, { stopReason: "end_turn" });
  } finally {
    await client.close();
  }
});

test("direct close terminates the Grok process group and its descendant", { skip: process.platform === "win32" }, async (t) => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "process-group-hanging");
  const client = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 15000
  });
  const processState = await waitForState(binDir, (state) => state.agentProcesses[0]);
  const { pid, descendantPid } = processState.agentProcesses[0];
  t.after(() => {
    for (const candidate of [descendantPid, pid]) {
      try {
        process.kill(candidate, "SIGKILL");
      } catch {
        // Already terminated by client.close().
      }
    }
  });

  await client.close();
  await Promise.all([waitForProcessExit(pid), waitForProcessExit(descendantPid)]);
});
