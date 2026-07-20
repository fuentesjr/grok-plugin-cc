import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobsDir, upsertJob, writeJobFile } from "./state.mjs";

export const DEATH_KIND = {
  REAPED_DEAD_WORKER: "reaped-dead-worker",
  UNCAUGHT_EXCEPTION: "uncaught-exception",
  UNHANDLED_REJECTION: "unhandled-rejection",
  SIGNAL: "signal",
  SESSION_END: "session-end",
  CANCELLED: "cancelled",
  BUDGET_EXPIRED: "budget-expired"
};

export const MAX_PARTIAL_MESSAGE_CHARS = 8_000;

export function nowIso() {
  return new Date().toISOString();
}

export function truncateForensicsText(value, maxChars = MAX_PARTIAL_MESSAGE_CHARS) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

export function resolveJobDumpFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.dump.json`);
}

function appendForensicsLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

function appendForensicsLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function mergeForensics(existing, patch) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const next = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  return {
    ...base,
    ...next,
    hints: mergeHints(base.hints, next.hints)
  };
}

function mergeHints(left, right) {
  const values = [];
  for (const source of [left, right]) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const hint of source) {
      const normalized = String(hint ?? "").trim();
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    }
  }
  return values.length > 0 ? values : undefined;
}

export function buildRuntimeIdentity(options = {}) {
  return {
    pid: options.pid ?? process.pid,
    ppid: options.ppid ?? process.ppid,
    platform: process.platform,
    node: process.version,
    pluginVersion: options.pluginVersion ?? null,
    dispatch: options.dispatch ?? null,
    argv: Array.isArray(options.argv) ? options.argv.slice(0, 32) : process.argv.slice(0, 32)
  };
}

/**
 * Patch forensics on both the job index and the per-job file.
 * Safe to call from progress checkpoints and death paths.
 */
export function patchJobForensics(workspaceRoot, jobId, forensicsPatch, options = {}) {
  if (!workspaceRoot || !jobId || !forensicsPatch) {
    return null;
  }

  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const existing = fs.existsSync(jobFile) ? readJobFile(jobFile) ?? {} : {};
  const forensics = mergeForensics(existing.forensics, {
    ...forensicsPatch,
    updatedAt: nowIso()
  });
  const recordPatch = {
    ...(options.recordPatch ?? {}),
    forensics
  };

  if (fs.existsSync(jobFile) || options.createIfMissing) {
    writeJobFile(workspaceRoot, jobId, {
      ...existing,
      ...recordPatch,
      id: jobId,
      forensics
    });
  }

  upsertJob(workspaceRoot, {
    id: jobId,
    ...recordPatch,
    forensics
  });

  return forensics;
}

export function writeJobDump(workspaceRoot, jobId, dump) {
  if (!workspaceRoot || !jobId || !dump) {
    return null;
  }
  const dumpFile = resolveJobDumpFile(workspaceRoot, jobId);
  fs.writeFileSync(dumpFile, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
  patchJobForensics(workspaceRoot, jobId, { dumpFile });
  return dumpFile;
}

export function recordJobDeath(workspaceRoot, jobId, death, options = {}) {
  const existing = fs.existsSync(resolveJobFile(workspaceRoot, jobId))
    ? readJobFile(resolveJobFile(workspaceRoot, jobId)) ?? {}
    : {};
  const completedAt = options.completedAt ?? nowIso();
  const logFile = options.logFile ?? existing.logFile ?? null;
  const errorMessage = death.errorMessage ?? existing.errorMessage ?? "Job ended unexpectedly.";
  const forensics = mergeForensics(existing.forensics, {
    deathKind: death.deathKind,
    detectedAt: completedAt,
    signal: death.signal ?? null,
    exitCode: death.exitCode ?? null,
    errorName: death.errorName ?? null,
    errorMessage,
    stack: death.stack ? truncateForensicsText(death.stack, 4000) : existing.forensics?.stack ?? null,
    lastPhase: existing.phase ?? existing.forensics?.lastPhase ?? null,
    lastProgressAt: existing.forensics?.lastProgressAt ?? existing.updatedAt ?? null,
    threadId: existing.threadId ?? existing.forensics?.threadId ?? null,
    turnId: existing.turnId ?? existing.forensics?.turnId ?? null,
    runtime: mergeForensics(existing.forensics?.runtime, death.runtime ?? buildRuntimeIdentity()),
    hints: death.hints ?? []
  });

  if (logFile) {
    appendForensicsLogLine(logFile, `INTERRUPTED (${forensics.deathKind}): ${errorMessage}`);
    if (death.stack) {
      appendForensicsLogBlock(logFile, "Crash stack", truncateForensicsText(death.stack, 4000));
    }
  }

  const dumpFile = resolveJobDumpFile(workspaceRoot, jobId);
  forensics.dumpFile = dumpFile;

  const nextRecord = {
    ...existing,
    status: options.status ?? "failed",
    phase: options.phase ?? "failed",
    pid: null,
    childPid: null,
    completedAt,
    errorMessage,
    forensics,
    logFile
  };
  writeJobFile(workspaceRoot, jobId, nextRecord);
  upsertJob(workspaceRoot, {
    id: jobId,
    status: nextRecord.status,
    phase: nextRecord.phase,
    pid: null,
    childPid: null,
    completedAt,
    errorMessage,
    forensics,
    logFile
  });

  fs.writeFileSync(
    dumpFile,
    `${JSON.stringify(
      {
        jobId,
        completedAt,
        deathKind: forensics.deathKind,
        errorMessage,
        forensics,
        partialFinalMessage: forensics.partialFinalMessage ?? null,
        job: {
          status: nextRecord.status,
          phase: nextRecord.phase,
          threadId: nextRecord.threadId ?? null,
          turnId: nextRecord.turnId ?? null,
          title: nextRecord.title ?? null,
          summary: nextRecord.summary ?? null,
          dispatch: forensics.runtime?.dispatch ?? null
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return { ...nextRecord, dumpFile };
}

/**
 * Install best-effort process death handlers that flush forensics for the active job.
 * Hard kills (SIGKILL / process-group teardown) will not run these — rely on checkpoints + reaper.
 */
export function installJobDeathHandlers({ workspaceRoot, jobId, logFile = null, dispatch = null, pluginVersion = null }) {
  if (!workspaceRoot || !jobId) {
    return () => {};
  }

  let finalized = false;
  const runtime = buildRuntimeIdentity({ dispatch, pluginVersion });

  const finalize = (deathKind, details = {}) => {
    if (finalized) {
      return;
    }
    finalized = true;
    try {
      recordJobDeath(
        workspaceRoot,
        jobId,
        {
          deathKind,
          errorMessage: details.errorMessage ?? `Job process terminated (${deathKind}).`,
          signal: details.signal ?? null,
          exitCode: details.exitCode ?? null,
          errorName: details.errorName ?? null,
          stack: details.stack ?? null,
          runtime,
          hints: details.hints ?? [`death-handler:${deathKind}`]
        },
        { logFile }
      );
    } catch {
      // Best-effort only — never throw from a signal path.
    }
  };

  const onException = (error) => {
    finalize(DEATH_KIND.UNCAUGHT_EXCEPTION, {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "Error",
      stack: error instanceof Error ? error.stack : null
    });
  };
  const onRejection = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    finalize(DEATH_KIND.UNHANDLED_REJECTION, {
      errorMessage: error.message,
      errorName: error.name,
      stack: error.stack
    });
  };
  const onSignal = (signal) => {
    finalize(DEATH_KIND.SIGNAL, {
      errorMessage: `Received ${signal}.`,
      signal,
      hints: ["process-signal"]
    });
    // Allow default termination after flush.
    setTimeout(() => process.exit(1), 10).unref?.();
  };

  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");

  process.once("uncaughtException", onException);
  process.once("unhandledRejection", onRejection);
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  return () => {
    finalized = true;
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
}

export function formatForensicsLines(forensics) {
  if (!forensics || typeof forensics !== "object") {
    return [];
  }
  const lines = [];
  if (forensics.deathKind) {
    lines.push(`  Forensics: ${forensics.deathKind}`);
  }
  if (forensics.signal) {
    lines.push(`  Signal: ${forensics.signal}`);
  }
  if (forensics.lastProgressAt) {
    lines.push(`  Last progress: ${forensics.lastProgressAt}`);
  }
  if (forensics.partialFinalMessageChars != null) {
    lines.push(`  Partial assistant message: ${forensics.partialFinalMessageChars} chars captured`);
  }
  if (forensics.dumpFile) {
    lines.push(`  Dump: ${forensics.dumpFile}`);
  } else if (forensics.runtime?.dispatch) {
    lines.push(`  Dispatch: ${forensics.runtime.dispatch}`);
  }
  if (Array.isArray(forensics.hints) && forensics.hints.length > 0) {
    lines.push(`  Hints: ${forensics.hints.join("; ")}`);
  }
  return lines;
}

export function recoveryHintsForJob(jobId) {
  return [
    `Recover with: /grok:status ${jobId}`,
    `Final output: /grok:result ${jobId}`,
    `Cancel: /grok:cancel ${jobId}`
  ];
}
