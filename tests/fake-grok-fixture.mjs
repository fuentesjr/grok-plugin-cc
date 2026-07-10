import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeGrok(binDir, behavior = "task-ok") {
  const statePath = path.join(binDir, "fake-grok-state.json");
  const scriptPath = path.join(binDir, "grok");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const pendingPrompts = new Map();

function defaultState() {
  return {
    nextSessionId: 1,
    spawns: [],
    initializations: [],
    sessions: [],
    prompts: [],
    cancellations: [],
    agentProcesses: []
  };
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return defaultState();
  }
  return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function parseSpawnArgs(args) {
  let index = 0;
  let sandboxProfile = null;
  let model = null;
  let effort = null;
  let noLeader = false;
  let alwaysApprove = false;

  if (args[index] === "--sandbox") {
    sandboxProfile = args[index + 1] || null;
    index += 2;
  }
  if (args[index] !== "agent") {
    return { valid: false, detail: "expected agent subcommand" };
  }
  index += 1;

  while (index < args.length) {
    const token = args[index];
    if (token === "stdio") {
      index += 1;
      break;
    }
    if (token === "-m" || token === "--model") {
      model = args[index + 1] || null;
      index += 2;
      continue;
    }
    if (token === "--reasoning-effort" || token === "--effort") {
      effort = args[index + 1] || null;
      index += 2;
      continue;
    }
    if (token === "--no-leader") {
      noLeader = true;
      index += 1;
      continue;
    }
    if (token === "--always-approve") {
      alwaysApprove = true;
      index += 1;
      continue;
    }
    return { valid: false, detail: "unexpected argument " + token };
  }

  return {
    valid: index === args.length && args[index - 1] === "stdio" && noLeader && alwaysApprove,
    sandboxProfile,
    model,
    effort,
    noLeader,
    alwaysApprove
  };
}

const args = process.argv.slice(2);
const state = loadState();

if (args.length === 1 && args[0] === "--version") {
  state.spawns.push({ mode: "version", args });
  saveState(state);
  process.stdout.write("grok 0.2.93\\n");
  process.exit(0);
}

const parsedArgs = parseSpawnArgs(args);
state.spawns.push({ mode: "agent", args, ...parsedArgs });
saveState(state);

if (!parsedArgs.valid) {
  process.stderr.write("fake grok: " + parsedArgs.detail + "\\n");
  process.exit(2);
}

if (BEHAVIOR === "spawn-fail") {
  process.stderr.write("fake grok raw failure tail: agent process could not start\\n");
  process.exit(23);
}

if (BEHAVIOR === "process-group-hanging") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  state.agentProcesses.push({ pid: process.pid, descendantPid: descendant.pid });
  saveState(state);
}

function authError(id) {
  send({
    id,
    error: {
      code: -32003,
      message: "Authentication required. Run grok login.",
      data: { kind: "auth_required" }
    }
  });
}

function emitUpdate(sessionId, update) {
  send({ method: "session/update", params: { sessionId, update } });
}

function emitCompletingTurn(sessionId, messageChunks) {
  emitUpdate(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Inspecting the workspace." }
  });
  emitUpdate(sessionId, {
    sessionUpdate: "plan",
    entries: [{ content: "Inspect and verify", status: "completed" }]
  });
  emitUpdate(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tool_1",
    title: "Run tests",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm test" }
  });
  emitUpdate(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool_1",
    title: "Run tests",
    kind: "execute",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "17 tests passed" } }]
  });
  for (const text of messageChunks) {
    emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text }
    });
  }
}

function handlePrompt(message) {
  const sessionId = message.params && message.params.sessionId;
  const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!session) {
    send({ id: message.id, error: { code: -32000, message: "unknown session " + sessionId } });
    return;
  }

  state.prompts.push({ sessionId, prompt: message.params.prompt });
  saveState(state);

  if (BEHAVIOR === "hanging") {
    pendingPrompts.set(sessionId, message.id);
    return;
  }

  if (BEHAVIOR === "review-ok") {
    emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: JSON.stringify({
          verdict: "approve",
          summary: "No material findings.",
          findings: [],
          next_steps: []
        })
      }
    });
  } else if (BEHAVIOR === "invalid-json") {
    emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "This is not JSON." }
    });
  } else if (BEHAVIOR === "streaming") {
    for (const text of ["Streamed ", "answer ", "complete."]) {
      emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text }
      });
    }
  } else if (BEHAVIOR === "delayed") {
    setTimeout(() => {
      emitCompletingTurn(sessionId, ["Delayed ", "completion."]);
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }, 300);
    return;
  } else {
    emitCompletingTurn(sessionId, ["Task ", "completed."]);
  }

  send({ id: message.id, result: { stopReason: "end_turn" } });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write("invalid JSON from client: " + error.message + "\\n");
    return;
  }

  switch (message.method) {
    case "initialize":
      state.initializations.push(message.params);
      saveState(state);
      if (BEHAVIOR === "auth-required") {
        authError(message.id);
        break;
      }
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false }
          }
        }
      });
      break;

    case "session/new": {
      if (BEHAVIOR === "auth-required") {
        authError(message.id);
        break;
      }
      const sessionId = "session_" + state.nextSessionId++;
      state.sessions.push({
        sessionId,
        cwd: message.params.cwd,
        mcpServers: message.params.mcpServers,
        sandboxProfile: parsedArgs.sandboxProfile,
        model: parsedArgs.model,
        effort: parsedArgs.effort,
        rules: message.params._meta && message.params._meta.rules,
        meta: message.params._meta || null
      });
      saveState(state);
      send({ id: message.id, result: { sessionId } });
      break;
    }

    case "session/prompt":
      handlePrompt(message);
      break;

    case "session/cancel": {
      const sessionId = message.params && message.params.sessionId;
      state.cancellations.push({ sessionId });
      saveState(state);
      const promptId = pendingPrompts.get(sessionId);
      if (promptId !== undefined) {
        pendingPrompts.delete(sessionId);
        send({ id: promptId, result: { stopReason: "cancelled" } });
      }
      break;
    }

    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
      }
      break;
  }
});
`;

  writeExecutable(scriptPath, source);

  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0grok" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "grok.cmd"), cmdWrapper, { encoding: "utf8" });
  }

  return { scriptPath, statePath };
}

export function readFakeGrokState(binDir) {
  const statePath = path.join(binDir, "fake-grok-state.json");
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
}

export function buildEnv(binDir, overrides = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    ...overrides,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
