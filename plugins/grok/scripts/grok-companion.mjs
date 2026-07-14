#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  getWorkingTreeState,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  buildPersistentTaskThreadName,
  cancelAcpTurn,
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_JOB_BUDGET_MS,
  DEFAULT_BUDGET_GRACE_MS,
  findLatestTaskThread,
  getGrokAuthStatus,
  getGrokAvailability,
  getSessionRuntimeStatus,
  runAcpReview,
  runAcpTurn
} from "./lib/grok.mjs";
import { BROKER_BUSY_RPC_CODE } from "./lib/acp-client.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  resolveStatusWaitDeadlineMs,
  sortJobsNewestFirst,
  STATUS_WAIT_TIMEOUT_EXIT_CODE
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";
import { generateJobId, getConfig, listJobs, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;
const FAST_MODEL_ALIAS = "grok-composer-2.5-fast";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [-C <path>] [--json] [--enable-review-gate|--disable-review-gate]",
      "  node scripts/grok-companion.mjs review [-C <path>] [--base <ref>] [--scope <auto|working-tree|branch>] [--budget-ms <ms>] [--json]",
      "  node scripts/grok-companion.mjs adversarial-review [-C <path>] [--base <ref>] [--scope <auto|working-tree|branch>] [--budget-ms <ms>] [--json] [focus]",
      "  node scripts/grok-companion.mjs task [-C <path>] [--background|--wait] [--write] [--resume-last|--resume|--fresh] [--model <model|fast>] [--effort <value>] [--budget-ms <ms>] [prompt]",
      "  node scripts/grok-companion.mjs status [-C <path>] [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  node scripts/grok-companion.mjs result [-C <path>] [job-id] [--json]",
      "  node scripts/grok-companion.mjs cancel [-C <path>] [job-id] [--json]",
      "",
      "Notes:",
      "  --budget-ms <ms>   Wall-clock job budget (default 1200000 = 20 minutes).",
      "                    Also overridable via GROK_COMPANION_BUDGET_MS.",
      "                    On expiry the turn is cancelled, then a short wind-down",
      "                    prompt asks Grok to write a handoff of remaining work.",
      "  --timeout-ms <ms> For status --wait only. By default waits until the job's",
      `                    budget deadline (budget + ${DEFAULT_BUDGET_GRACE_MS}ms grace from job start).`,
      `                    Wait timeout exits ${STATUS_WAIT_TIMEOUT_EXIT_CODE} with the job still active;`,
      "                    that is not a job failure."
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  const normalized = String(model ?? "").trim();
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase() === "fast" ? FAST_MODEL_ALIAS : normalized;
}

function normalizeEffort(effort) {
  const normalized = String(effort ?? "").trim();
  return normalized || null;
}

function normalizeBudgetMs(value) {
  if (value == null || value === "") {
    const fromEnv = Number(process.env.GROK_COMPANION_BUDGET_MS);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
      return Math.floor(fromEnv);
    }
    const testDefault = Number(process.env.GROK_COMPANION_TEST_DEFAULT_BUDGET_MS);
    return Number.isFinite(testDefault) && testDefault > 0
      ? Math.floor(testDefault)
      : DEFAULT_JOB_BUDGET_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--budget-ms must be a positive number.");
  }
  return Math.floor(parsed);
}

function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }
  const [raw] = argv;
  return raw?.trim() ? splitRawArgumentString(raw) : [];
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? fallback
  );
}

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error("Grok Build is unavailable. Install it, run `grok login`, then rerun `/grok:setup`.");
  }
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const previousVersion = config.lastVerifiedGrokVersion ?? null;
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = await getGrokAuthStatus(cwd);
  const currentVersion = grokStatus.available ? grokStatus.detail : null;
  const versionDrift =
    previousVersion && currentVersion && previousVersion !== currentVersion
      ? { previous: previousVersion, current: currentVersion }
      : null;
  const warnings = versionDrift
    ? [
        `Grok is now ${versionDrift.current}; plugin behavior was last verified against ${versionDrift.previous}. Run one cheap read-only /grok:rescue to re-verify behavior.`
      ]
    : [];
  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install Grok Build, then rerun `/grok:setup`.");
  } else if (!authStatus.loggedIn) {
    nextSteps.push("Run `grok login`, then rerun `/grok:setup`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to require a fresh review before stop.");
  }
  const ready = nodeStatus.available && grokStatus.available && authStatus.loggedIn;
  if (ready) {
    setConfig(workspaceRoot, "lastVerifiedGrokVersion", currentVersion);
  }
  return {
    ready,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    versionDrift,
    warnings,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }
  const report = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  return sessionId ? jobs.filter((job) => job.sessionId === sessionId) : jobs;
}

function findLatestResumableTaskJob(jobs, excludeJobId = null) {
  return (
    jobs.find(
      (job) =>
        job.id !== excludeJobId &&
        job.jobClass === "task" &&
        job.status === "completed" &&
        typeof job.threadId === "string" &&
        job.threadId
    ) ?? null
  );
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(cwd)));
  const active = jobs.find(
    (job) => job.id !== options.excludeJobId && job.jobClass === "task" && ["queued", "running"].includes(job.status)
  );
  if (active) {
    throw new Error(`Task ${active.id} is still running. Use /grok:status before continuing it.`);
  }
  const tracked = findLatestResumableTaskJob(jobs, options.excludeJobId);
  if (tracked) {
    return { id: tracked.threadId };
  }
  if (getCurrentClaudeSessionId()) {
    return null;
  }
  return findLatestTaskThread(cwd);
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    ...(kind === "adversarial-review" ? {} : { kindLabel: jobClass === "review" ? "review" : "rescue" }),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  ensureGitRepository(request.cwd);
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const context = collectReviewContext(request.cwd, target);
  const result = await runAcpReview(context.repoRoot, {
    promptName: request.promptName ?? "review",
    userFocus: request.userFocus,
    targetLabel: context.target.label,
    reviewInput: context.content,
    reviewCollectionGuidance: context.collectionGuidance,
    model: request.model,
    budgetMs: request.budgetMs,
    onProgress: request.onProgress
  });
  const parsed = result.result;
  const reviewLabel = request.reviewLabel ?? "Review";
  const payload = {
    jobId: request.jobId,
    review: reviewLabel,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.reviewText,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary:
      parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.reviewText, `${reviewLabel} finished.`),
    jobTitle: request.jobTitle ?? "Grok Review",
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "budget-ms"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });
  if (positionals.length > 0) {
    throw new Error("`/grok:review` does not accept custom focus text.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const job = createCompanionJob({
    prefix: "review",
    kind: "review",
    title: "Grok Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Review ${target.label}`
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        budgetMs: normalizeBudgetMs(options["budget-ms"]),
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleAdversarialReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "budget-ms"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const focusText = positionals.join(" ") || "No extra focus provided.";
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const job = createCompanionJob({
    prefix: "adversarial-review",
    kind: "adversarial-review",
    title: "Grok Adversarial Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Adversarial review ${target.label}`
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        budgetMs: normalizeBudgetMs(options["budget-ms"]),
        promptName: "adversarial-review",
        userFocus: focusText,
        reviewLabel: "Adversarial Review",
        jobTitle: "Grok Adversarial Review",
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  return positionals.join(" ") || readStdinIfPiped();
}

function buildTaskMetadata(prompt, resumeLast) {
  return {
    title: resumeLast ? "Grok Resume" : "Grok Task",
    summary: shorten(prompt || DEFAULT_CONTINUE_PROMPT)
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);
  let resumeThreadId = null;
  if (request.resumeLast) {
    const latest = await resolveLatestTrackedTaskThread(workspaceRoot, { excludeJobId: request.jobId });
    if (!latest) {
      throw new Error("No previous Grok task session was found for this repository.");
    }
    resumeThreadId = latest.id;
  }
  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
  let result;
  try {
    result = await runAcpTurn(workspaceRoot, {
      resumeThreadId,
      prompt: request.prompt,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model: request.model,
      effort: request.effort,
      sandbox: request.write ? "workspace" : "read-only",
      budgetMs: request.budgetMs,
      brokerFallback: request.brokerFallback,
      onProcessSpawn: (childPid) => updateJobChildPid(workspaceRoot, request.jobId, childPid),
      onProcessExit: () => updateJobChildPid(workspaceRoot, request.jobId, null),
      onProgress: request.onProgress,
      persistThread: request.persistThread ?? true,
      threadName: resumeThreadId
        ? null
        : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
    });
  } catch (error) {
    if (error?.rpcCode !== BROKER_BUSY_RPC_CODE || request.jobClass !== "stop-review") {
      throw error;
    }
    const payload = {
      jobId: request.jobId,
      status: "broker-busy",
      brokerBusy: true,
      rawOutput: ""
    };
    return {
      exitStatus: 0,
      threadId: null,
      turnId: null,
      payload,
      rendered: renderTaskResult({ rawOutput: "", failureMessage: "Shared Grok ACP broker is busy." }, { title: "Grok Task" }),
      summary: "Shared Grok ACP broker is busy.",
      jobTitle: request.jobTitle ?? "Grok Task",
      jobClass: request.jobClass ?? "task",
      write: Boolean(request.write)
    };
  }
  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const payload = {
    jobId: request.jobId,
    status: result.status,
    stopReason: result.stopReason,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderTaskResult({ rawOutput, failureMessage }, { title: "Grok Task" }),
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, "Grok task finished.")),
    jobTitle: request.resumeLast ? "Grok Resume" : "Grok Task",
    jobClass: request.jobClass ?? "task",
    write: Boolean(request.write)
  };
}

async function handleStopReviewTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "budget-ms"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = positionals.join(" ") || readStdinIfPiped();
  const job = createCompanionJob({
    prefix: "stop-review",
    kind: "task",
    title: "Grok Stop Review",
    workspaceRoot,
    jobClass: "stop-review",
    summary: shorten(prompt)
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model: null,
        effort: null,
        prompt,
        write: false,
        resumeLast: false,
        budgetMs: normalizeBudgetMs(options["budget-ms"]),
        brokerFallback: false,
        persistThread: false,
        jobClass: "stop-review",
        jobTitle: "Grok Stop Review",
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

function updateJobChildPid(workspaceRoot, jobId, childPid) {
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (storedJob) {
    writeJobFile(workspaceRoot, jobId, { ...storedJob, childPid });
  }
  upsertJob(workspaceRoot, { id: jobId, childPid });
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  const child = spawnDetachedTaskWorker(cwd, job.id);
  const launchedRecord = {
    ...queuedRecord,
    pid: child.pid ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, launchedRecord);
  upsertJob(job.workspaceRoot, launchedRecord);
  return {
    jobId: job.id,
    status: "queued",
    title: job.title,
    summary: job.summary,
    logFile
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok:status ${payload.jobId} for progress.\n`;
}

function assertBackgroundWriteAllowed(workspaceRoot) {
  if (!getWorkingTreeState(workspaceRoot).isDirty) {
    return;
  }
  throw new Error(
    "Background write tasks require a clean working tree. Commit or stash existing changes, or run with --wait."
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "budget-ms"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const metadata = buildTaskMetadata(prompt, resumeLast);
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: metadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: metadata.summary,
    write
  });
  const request = {
    cwd,
    model: normalizeRequestedModel(options.model),
    effort: normalizeEffort(options.effort),
    prompt,
    write,
    resumeLast,
    budgetMs: normalizeBudgetMs(options["budget-ms"]),
    jobId: job.id
  };

  if (options.background && !options.wait) {
    ensureGrokAvailable(cwd);
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }
    if (write) {
      assertBackgroundWriteAllowed(workspaceRoot);
    }
    const payload = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) => executeTaskRun({ ...request, onProgress: progress }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  if (!storedJob.request || typeof storedJob.request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }
  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTaskRun({ ...storedJob.request, onProgress: progress }),
    { logFile }
  );
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const waitStartedAt = Date.now();
  const pollIntervalMs = Number(options.pollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS);
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  const storedJob = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);

  while (true) {
    if (!isActiveStatus(snapshot.job.status)) {
      return { snapshot, waitTimedOut: false, waitTimeoutMs: Date.now() - waitStartedAt };
    }

    // Re-resolve each poll so a queued→running transition re-anchors to the job budget.
    const deadlineMs = resolveStatusWaitDeadlineMs({
      job: snapshot.job,
      storedJob,
      explicitTimeoutMs: options.timeoutMs,
      waitStartedAt,
      now: Date.now()
    });
    const now = Date.now();
    if (now >= deadlineMs) {
      return {
        snapshot,
        waitTimedOut: true,
        waitTimeoutMs: now - waitStartedAt,
        waitDeadlineMs: deadlineMs
      };
    }

    const sleepMs = Math.min(pollIntervalMs, Math.max(1, deadlineMs - now));
    await sleep(sleepMs);
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }
}

function outputWaitTimeout(snapshot, waitTimeoutMs, asJson) {
  const detail =
    `Timed out waiting for job ${snapshot.job.id} after ${waitTimeoutMs}ms; ` +
    `job is still ${snapshot.job.status}` +
    (snapshot.job.phase ? ` (phase: ${snapshot.job.phase})` : "") +
    ". This is a wait timeout, not a job failure — re-run status, pass a larger --timeout-ms, or cancel the job.";
  const payload = {
    ...snapshot,
    waitTimedOut: true,
    waitTimeoutMs,
    error: detail
  };
  if (asJson) {
    outputResult(payload, true);
  } else {
    process.stderr.write(`${detail}\n`);
    process.stdout.write(renderJobStatusReport(snapshot.job));
  }
  process.exitCode = STATUS_WAIT_TIMEOUT_EXIT_CODE;
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    if (options.wait) {
      const { snapshot, waitTimedOut, waitTimeoutMs } = await waitForSingleJobSnapshot(cwd, reference, {
        timeoutMs: options["timeout-ms"],
        pollIntervalMs: options["poll-interval-ms"]
      });
      if (waitTimedOut) {
        outputWaitTimeout(snapshot, waitTimeoutMs, options.json);
        return;
      }
      outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
      return;
    }
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }
  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }
  const report = buildStatusSnapshot(cwd, { all: options.all, env: process.env });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);
  const payload = {
    available: Boolean(candidate),
    sessionId: getCurrentClaudeSessionId(),
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };
  outputCommandResult(
    payload,
    candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).\n` : "No resumable task found for this session.\n",
    options.json
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const interrupt = await cancelAcpTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Grok session cancellation for ${threadId}.`
        : `Grok session cancellation failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }
  try {
    terminateProcessTree(job.pid ?? Number.NaN);
  } catch {
    // State cancellation remains authoritative if the worker already exited.
  }
  try {
    terminateProcessTree(existing.childPid ?? job.childPid ?? Number.NaN);
  } catch {
    // State cancellation remains authoritative if the direct child already exited.
  }
  appendLogLine(job.logFile, "Cancelled by user.");
  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    childPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    childPid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "stop-review-task":
      await handleStopReviewTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
