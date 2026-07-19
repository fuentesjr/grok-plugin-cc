import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { processIsAlive, terminateProcessTree } from "../plugins/grok/scripts/lib/process.mjs";

test("processIsAlive returns true for the current process", () => {
  assert.equal(processIsAlive(process.pid), true);
});

test("processIsAlive returns false for a dead pid", () => {
  // PID 1 may exist on unix; use a high unused pid unlikely to be alive.
  // If somehow alive, the assertion would fail — retry with another candidate.
  let foundDead = false;
  for (const candidate of [2_147_483_646, 2_147_483_645, 999_999_999]) {
    if (processIsAlive(candidate) === false) {
      foundDead = true;
      break;
    }
  }
  assert.equal(foundDead, true);
});

test("processIsAlive returns null for missing or non-integer pids", () => {
  assert.equal(processIsAlive(null), null);
  assert.equal(processIsAlive(undefined), null);
  assert.equal(processIsAlive(0), null);
  assert.equal(processIsAlive(-1), null);
  assert.equal(processIsAlive(1.5), null);
  assert.equal(processIsAlive("123"), null);
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
