import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  JSON_READ_MAX_ATTEMPTS,
  readJsonFile,
  writeJsonFileAtomic
} from "../plugins/grok/scripts/lib/fs.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/grok/scripts/lib/state.mjs";

// Keep fallback-state tests independent of the host Claude session.
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.GROK_COMPANION_DATA_DIR;

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir prefers Grok-specific plugin data over shared CLAUDE_PLUGIN_DATA", () => {
  const workspace = makeTempDir();
  const sharedPluginDataDir = makeTempDir();
  const grokPluginDataDir = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = sharedPluginDataDir;
  process.env.GROK_COMPANION_DATA_DIR = grokPluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(grokPluginDataDir, "state")), true);
    assert.equal(stateDir.startsWith(path.join(sharedPluginDataDir, "state")), false);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.GROK_COMPANION_DATA_DIR;
  }
});

test("resolveStateDir ignores foreign ambient CLAUDE_PLUGIN_DATA (e.g. codex)", () => {
  const workspace = makeTempDir();
  // Mimic Claude Code's shared env after the Codex companion SessionStart hook:
  // basename is not a Grok plugin data root.
  const codexPluginDataDir = makeTempDir("codex-openai-codex-");
  process.env.CLAUDE_PLUGIN_DATA = codexPluginDataDir;
  delete process.env.GROK_COMPANION_DATA_DIR;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(codexPluginDataDir, "state")), false);
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("resolveStateDir accepts CLAUDE_PLUGIN_DATA only when it looks like a Grok data root", () => {
  const workspace = makeTempDir();
  const grokPluginDataDir = makeTempDir("grok-grok-");
  process.env.CLAUDE_PLUGIN_DATA = grokPluginDataDir;
  delete process.env.GROK_COMPANION_DATA_DIR;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(grokPluginDataDir, "state")), true);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = readJsonFile(stateFile);
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("writeJsonFileAtomic + readJsonFile survive a concurrent multi-process writer", async () => {
  const dir = makeTempDir();
  const target = path.join(dir, "shared.json");
  writeJsonFileAtomic(target, { ok: true, i: 0, pad: "x".repeat(2000) });

  const writerScript = `
    import { writeJsonFileAtomic } from ${JSON.stringify(
      fileURLToPath(new URL("../plugins/grok/scripts/lib/fs.mjs", import.meta.url))
    )};
    const target = ${JSON.stringify(target)};
    for (let i = 0; i < 8000; i += 1) {
      writeJsonFileAtomic(target, { ok: true, i, pad: "x".repeat(2000) });
    }
  `;
  const writer = spawn(process.execPath, ["--input-type=module", "-e", writerScript], {
    stdio: "ignore"
  });

  let ok = 0;
  let failures = 0;
  const started = Date.now();
  while (Date.now() - started < 600) {
    try {
      const parsed = readJsonFile(target);
      assert.equal(parsed.ok, true);
      ok += 1;
    } catch {
      failures += 1;
    }
  }

  writer.kill("SIGTERM");
  await new Promise((resolve) => {
    writer.once("exit", resolve);
    setTimeout(resolve, 500);
  });

  assert.equal(failures, 0, `expected 0 parse failures under atomic writes, got ${failures} (ok=${ok})`);
  assert.ok(ok > 100, `expected sustained concurrent reads, got ok=${ok}`);
});

test("writeJobFile is multi-process safe for parent/worker job dumps", async () => {
  const workspace = makeTempDir();
  const jobId = "task-race-test";
  writeJobFile(workspace, jobId, { id: jobId, status: "queued", pad: "y".repeat(1500) });
  const jobFile = resolveJobFile(workspace, jobId);

  const writerScript = `
    import { writeJobFile } from ${JSON.stringify(
      fileURLToPath(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url))
    )};
    const workspace = ${JSON.stringify(workspace)};
    const jobId = ${JSON.stringify(jobId)};
    for (let i = 0; i < 6000; i += 1) {
      writeJobFile(workspace, jobId, { id: jobId, status: "running", i, pad: "y".repeat(1500) });
    }
  `;
  const writer = spawn(process.execPath, ["--input-type=module", "-e", writerScript], {
    stdio: "ignore"
  });

  let ok = 0;
  let failures = 0;
  const started = Date.now();
  while (Date.now() - started < 500) {
    try {
      const parsed = readJsonFile(jobFile);
      assert.equal(parsed.id, jobId);
      ok += 1;
    } catch {
      failures += 1;
    }
  }

  writer.kill("SIGTERM");
  await new Promise((resolve) => {
    writer.once("exit", resolve);
    setTimeout(resolve, 500);
  });

  assert.equal(failures, 0, `writeJobFile race failures: ${failures} (ok=${ok})`);
  assert.ok(ok > 50, `expected concurrent job-file reads, got ok=${ok}`);
});

test("readJsonFile retries empty content then succeeds", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "eventual.json");
  fs.writeFileSync(target, "", "utf8");

  let writes = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = (filePath, encoding) => {
    if (path.resolve(String(filePath)) === path.resolve(target)) {
      writes += 1;
      if (writes >= 2) {
        return `${JSON.stringify({ recovered: true })}\n`;
      }
      return "";
    }
    return originalRead(filePath, encoding);
  };

  try {
    const parsed = readJsonFile(target, { maxAttempts: JSON_READ_MAX_ATTEMPTS, retryDelayMs: 1 });
    assert.deepEqual(parsed, { recovered: true });
    assert.ok(writes >= 2);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test("readJsonFile labels permanent parse failures after retries", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "broken.json");
  fs.writeFileSync(target, "{not-json", "utf8");

  assert.throws(
    () => readJsonFile(target, { maxAttempts: 2, retryDelayMs: 0 }),
    (error) => {
      assert.match(String(error.message), /Failed to read JSON file/);
      assert.match(String(error.message), /broken\.json/);
      return true;
    }
  );
});
