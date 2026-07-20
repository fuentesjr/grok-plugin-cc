import fs from "node:fs";
import process from "node:process";

import {
  buildRuntimeIdentity,
  installJobDeathHandlers,
  mergeForensics,
  truncateForensicsText
} from "./forensics.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastCheckpointMs = 0;
  const CHECKPOINT_MIN_INTERVAL_MS = 2_000;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;
    const now = Date.now();
    const forensicsPatch = {
      lastProgressAt: nowIso()
    };

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      forensicsPatch.lastPhase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      forensicsPatch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      forensicsPatch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.logTitle === "Assistant message" && normalized.logBody) {
      const body = String(normalized.logBody);
      forensicsPatch.partialFinalMessage = truncateForensicsText(body);
      forensicsPatch.partialFinalMessageChars = body.length;
      changed = true;
    }

    // Heartbeat even when phase is unchanged so hard-kill postmortems have a fresh stamp.
    if (!changed && now - lastCheckpointMs < CHECKPOINT_MIN_INTERVAL_MS) {
      return;
    }
    lastCheckpointMs = now;
    changed = true;

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    const storedJob = fs.existsSync(jobFile) ? readJobFile(jobFile) ?? {} : {};
    const forensics = mergeForensics(storedJob.forensics, forensicsPatch);
    patch.forensics = forensics;

    upsertJob(workspaceRoot, patch);

    if (!fs.existsSync(jobFile)) {
      return;
    }

    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch,
      forensics
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[grok] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  const dispatch = options.dispatch ?? job.forensics?.runtime?.dispatch ?? null;
  const pluginVersion = options.pluginVersion ?? job.forensics?.runtime?.pluginVersion ?? null;
  const runtime = buildRuntimeIdentity({ dispatch, pluginVersion });
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile,
    forensics: mergeForensics(job.forensics, {
      runtime,
      lastProgressAt: nowIso(),
      lastPhase: "starting"
    })
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  const uninstallDeathHandlers = installJobDeathHandlers({
    workspaceRoot: job.workspaceRoot,
    jobId: job.id,
    logFile,
    dispatch,
    pluginVersion
  });

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
      forensics: mergeForensics(existing.forensics, {
        completedCleanly: true,
        lastPhase: completionStatus === "completed" ? "done" : "failed",
        lastProgressAt: completedAt
      })
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    const forensics = mergeForensics(existing.forensics, {
      deathKind: "runner-exception",
      detectedAt: completedAt,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage,
      stack: error instanceof Error ? truncateForensicsText(error.stack, 4000) : null,
      lastPhase: "failed",
      lastProgressAt: completedAt,
      runtime
    });
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile,
      forensics
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt,
      forensics
    });
    appendLogLine(logFile, `FAILED: ${errorMessage}`);
    throw error;
  } finally {
    uninstallDeathHandlers();
  }
}
