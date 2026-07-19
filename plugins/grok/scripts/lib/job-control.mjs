import fs from "node:fs";

import {
  DEFAULT_BUDGET_GRACE_MS,
  DEFAULT_JOB_BUDGET_MS,
  getSessionRuntimeStatus
} from "./grok.mjs";
import { processIsAlive } from "./process.mjs";
import {
  getConfig,
  listJobs,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  saveState
} from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
/** Floor when a job's remaining budget has already elapsed. */
export const MIN_STATUS_WAIT_TIMEOUT_MS = 5_000;
/** Exit code for `status --wait` when the wait gave up while the job is still active. */
export const STATUS_WAIT_TIMEOUT_EXIT_CODE = 2;
/** Age cutoff when a running/queued job has no usable pid (shared with the Stop gate). */
export const STALE_RUNNING_JOB_AGE_MS = 12 * 60 * 1000;
const DEAD_WORKER_MESSAGE = "Worker process is no longer running.";

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function jobTimestampMs(job) {
  for (const value of [job.updatedAt, job.startedAt, job.createdAt]) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return null;
}

/**
 * Whether a queued/running job should still be treated as in-flight.
 * Dead workers (or stale null-pid records) are not in-flight.
 */
export function isJobInFlight(job, now = Date.now()) {
  if (job.status !== "queued" && job.status !== "running") {
    return false;
  }
  const alive = processIsAlive(job.pid);
  if (alive !== null) {
    return alive;
  }
  const timestamp = jobTimestampMs(job);
  return timestamp != null && now - timestamp <= STALE_RUNNING_JOB_AGE_MS;
}

function markJobWorkerDead(job, completedAt) {
  return {
    ...job,
    status: "failed",
    phase: "failed",
    pid: null,
    childPid: null,
    completedAt,
    errorMessage: DEAD_WORKER_MESSAGE
  };
}

/**
 * Persist failed status for queued/running jobs whose worker is gone so
 * resume-last / status / cancel no longer treat them as live.
 */
export function reapDeadJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const now = options.now ?? Date.now();
  const state = loadState(workspaceRoot);
  const completedAt = new Date(now).toISOString();
  let changed = false;
  const nextJobs = state.jobs.map((job) => {
    if ((job.status === "queued" || job.status === "running") && !isJobInFlight(job, now)) {
      changed = true;
      const reaped = markJobWorkerDead(job, completedAt);
      try {
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        if (fs.existsSync(jobFile)) {
          const existing = readJobFile(jobFile) ?? {};
          fs.writeFileSync(jobFile, `${JSON.stringify({ ...existing, ...reaped }, null, 2)}\n`, "utf8");
        }
      } catch {
        // Index update below remains authoritative if the per-job file is missing.
      }
      return reaped;
    }
    return job;
  });
  if (!changed) {
    return state.jobs;
  }
  saveState(workspaceRoot, { ...state, jobs: nextJobs });
  return nextJobs;
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output", "Plan"].includes(line) ||
    /^Tool .+ output$/.test(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting grok") || line.startsWith("session ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reasoning:") || line.startsWith("plan updated:")) {
      return "investigating";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("command failed:") || line.startsWith("tool failed:")) {
      return "failed";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("assistant message captured:") || line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("budget expired;") || line.startsWith("budget expired,")) {
      return "cancelling";
    }
    if (line.startsWith("session resumed")) {
      return "starting";
    }
    if (line.startsWith("turn cancelled")) {
      return "cancelled";
    }
    if (line.startsWith("grok error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /grok:status to list known jobs.`);
}

function withStateFileHint(message, workspaceRoot) {
  return `${message} State file: ${resolveStateFile(workspaceRoot)}`;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reapDeadJobs(workspaceRoot);
  const config = getConfig(workspaceRoot);
  const stateFile = resolveStateFile(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    stateFile,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reapDeadJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  let selected;
  try {
    selected = matchJobReference(jobs, reference);
  } catch (error) {
    throw new Error(withStateFileHint(error.message, workspaceRoot));
  }
  if (!selected) {
    throw new Error(
      withStateFileHint(`No job found for "${reference}". Run /grok:status to inspect known jobs.`, workspaceRoot)
    );
  }

  return {
    workspaceRoot,
    stateFile: resolveStateFile(workspaceRoot),
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

function resolveJobBudgetMs(storedJob, defaultBudgetMs = DEFAULT_JOB_BUDGET_MS) {
  const storedBudget = Number(storedJob?.request?.budgetMs);
  return Number.isFinite(storedBudget) && storedBudget > 0 ? Math.floor(storedBudget) : defaultBudgetMs;
}

/**
 * Absolute deadline for `status --wait`.
 *
 * - Explicit `--timeout-ms`: waitStartedAt + timeout (fixed window from when wait began).
 * - Default: job startedAt + budget + wind-down grace. If the job is still queued
 *   (no startedAt yet), the deadline is now + full allowance so queue time does not
 *   eat the productive wait window; once the job starts, callers should re-resolve.
 */
export function resolveStatusWaitDeadlineMs({
  job,
  storedJob = null,
  explicitTimeoutMs = null,
  waitStartedAt = Date.now(),
  now = Date.now(),
  defaultBudgetMs = DEFAULT_JOB_BUDGET_MS,
  defaultGraceMs = DEFAULT_BUDGET_GRACE_MS
} = {}) {
  if (explicitTimeoutMs != null && explicitTimeoutMs !== "") {
    const parsed = Number(explicitTimeoutMs);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--timeout-ms must be a positive number.");
    }
    return waitStartedAt + Math.floor(parsed);
  }

  const totalAllowanceMs = resolveJobBudgetMs(storedJob, defaultBudgetMs) + defaultGraceMs;
  const startedMs = Date.parse(job?.startedAt ?? "");
  if (Number.isFinite(startedMs)) {
    return startedMs + totalAllowanceMs;
  }
  // Still queued / no start stamp: grant a full allowance from "now".
  return now + totalAllowanceMs;
}

/**
 * Remaining ms until the wait deadline (floored at minTimeoutMs for overdue jobs).
 * Prefer resolveStatusWaitDeadlineMs in the wait loop; this helper is for tests/docs.
 */
export function resolveStatusWaitTimeoutMs({
  job,
  storedJob = null,
  explicitTimeoutMs = null,
  waitStartedAt = Date.now(),
  now = Date.now(),
  defaultBudgetMs = DEFAULT_JOB_BUDGET_MS,
  defaultGraceMs = DEFAULT_BUDGET_GRACE_MS,
  minTimeoutMs = MIN_STATUS_WAIT_TIMEOUT_MS
} = {}) {
  const deadline = resolveStatusWaitDeadlineMs({
    job,
    storedJob,
    explicitTimeoutMs,
    waitStartedAt,
    now,
    defaultBudgetMs,
    defaultGraceMs
  });
  return Math.max(deadline - now, minTimeoutMs);
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /grok:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /grok:status to inspect active jobs.`);
  }

  throw new Error("No finished Grok jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reapDeadJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    try {
      const selected = matchJobReference(activeJobs, reference);
      if (!selected) {
        throw new Error(`No active job found for "${reference}".`);
      }
      return { workspaceRoot, job: selected };
    } catch (error) {
      throw new Error(withStateFileHint(error.message, workspaceRoot));
    }
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error(
      withStateFileHint("Multiple Grok jobs are active. Pass a job id to /grok:cancel.", workspaceRoot)
    );
  }

  if (getCurrentSessionId(options)) {
    throw new Error(
      withStateFileHint("No active Grok jobs to cancel for this session.", workspaceRoot)
    );
  }

  throw new Error(withStateFileHint("No active Grok jobs to cancel.", workspaceRoot));
}
