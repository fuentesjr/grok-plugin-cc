#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { BROKER_ENDPOINT_ENV } from "./lib/acp-client.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { DEATH_KIND, recordJobDeath } from "./lib/forensics.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  GROK_DATA_DIR_ENV,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "GROK_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid session lifecycle hook input: ${error.message}`, { cause: error });
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }
  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  const completedAt = new Date().toISOString();

  for (const job of sessionJobs) {
    if (job.status !== "queued" && job.status !== "running") {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    try {
      terminateProcessTree(job.childPid ?? Number.NaN);
    } catch {
      // Ignore direct-child teardown failures during session shutdown.
    }
    // Keep the job record + forensics dump so a killed mid-turn job is still diagnosable.
    try {
      recordJobDeath(
        workspaceRoot,
        job.id,
        {
          deathKind: DEATH_KIND.SESSION_END,
          errorMessage: "Session ended while job was still active; worker was terminated.",
          hints: ["session-end-cleanup", "job-record-preserved-for-forensics"]
        },
        {
          completedAt,
          logFile: job.logFile ?? null,
          status: "cancelled",
          phase: "cancelled"
        }
      );
    } catch {
      try {
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        const existing = fs.existsSync(jobFile) ? readJobFile(jobFile) ?? {} : {};
        const next = {
          ...existing,
          ...job,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          childPid: null,
          completedAt,
          errorMessage: "Session ended while job was still active; worker was terminated."
        };
        writeJobFile(workspaceRoot, job.id, next);
        upsertJob(workspaceRoot, {
          id: job.id,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          childPid: null,
          completedAt,
          errorMessage: next.errorMessage
        });
      } catch {
        // Best-effort only during session teardown.
      }
    }
  }

  // Preserve finished and just-cancelled session jobs in the index (forensics /result).
  // Do not delete session job records on SessionEnd.
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(GROK_DATA_DIR_ENV, process.env[GROK_DATA_DIR_ENV] ?? process.env[CLAUDE_PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  const brokerShutdownConfirmed = brokerEndpoint ? await sendBrokerShutdown(brokerEndpoint) : false;
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  if (brokerShutdownConfirmed) {
    teardownBrokerSession({
      endpoint: brokerEndpoint,
      pidFile,
      logFile,
      sessionDir,
      pid,
      killProcess: terminateProcessTree
    });
  }
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";
  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }
  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
