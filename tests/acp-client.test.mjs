import assert from "node:assert/strict";
import test from "node:test";

import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp-client.mjs";
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

test("GrokAcpClient performs the verified ACP handshake and creates a session", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const client = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 1000
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

test("GrokAcpClient dispatches notifications and cancels an in-flight prompt", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeGrok(binDir, "hanging");
  const client = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    env: buildEnv(binDir),
    requestTimeoutMs: 1000
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
      requestTimeoutMs: 1000
    }),
    /fake grok raw failure tail: agent process could not start/
  );
});
