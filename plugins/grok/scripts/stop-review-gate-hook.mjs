#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getGrokAvailability } from "./lib/grok.mjs";
import { isJobInFlight as jobLooksInFlight, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_BUDGET_MS = 480_000;
const DEFAULT_STOP_REVIEW_TIMEOUT_MS = 600_000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, { CLAUDE_RESPONSE_BLOCK: claudeResponseBlock });
}

function buildSetupNote(cwd) {
  const availability = getGrokAvailability(cwd);
  if (availability.available) {
    return null;
  }
  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Grok Build is not set up for the review gate.${detail} Run /grok:setup.`;
}

function isJobInFlight(job, now = Date.now()) {
  // Stop-review jobs never block the gate (they are the gate).
  if (job.jobClass === "stop-review") {
    return false;
  }
  return jobLooksInFlight(job, now);
}

function describeRunningJobs(jobs, input = {}) {
  const inFlight = sortJobsNewestFirst(jobs.filter((job) => isJobInFlight(job)));
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const currentSessionJob = sessionId ? inFlight.find((job) => job.sessionId === sessionId) : null;
  const runningNote = currentSessionJob
    ? `Grok task ${currentSessionJob.id} is still running. Check /grok:status and use /grok:cancel ${currentSessionJob.id} if you want to stop it before ending the session.`
    : inFlight.length > 0
      ? "A Grok job from another session in this workspace is still running. Check /grok:status before ending the session."
      : null;
  return { busy: inFlight.length > 0, runningNote };
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Grok review task returned no final output. Run /grok:review --wait manually or bypass the gate."
    };
  }
  // Tier 1: the obeyed contract — verdict token anchors the first line.
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Grok stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }
  // Tier 2: grok reliably emits the verdict but often prepends a preamble sentence on
  // the same line (verified live against grok 0.2.93), so scan for a boundary-guarded,
  // case-sensitive verdict token anywhere. The lookbehind keeps DISALLOW: from matching.
  const matches = [...text.matchAll(/(?<![A-Za-z])(ALLOW|BLOCK):/g)];
  const kinds = new Set(matches.map((match) => match[1]));
  if (kinds.size === 1) {
    const first = matches[0];
    if (first[1] === "ALLOW") {
      return { ok: true, reason: null };
    }
    const afterToken = text.slice(first.index + first[0].length);
    const reason = afterToken.split(/\r?\n/, 1)[0].trim() || afterToken.trim();
    return {
      ok: false,
      reason: `Grok stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }
  // Zero tokens or both distinct verdicts: never guess — fail closed. Keep a short
  // excerpt so contract drift is diagnosable from the block reason.
  const excerpt = text.slice(0, 160).replace(/\s+/g, " ").trim();
  return {
    ok: false,
    reason:
      `The stop-time Grok review task returned an unexpected answer (began: "${excerpt}"). Run /grok:review --wait manually or bypass the gate.`
  };
}

function stopReviewTimeoutMs() {
  const override = Number(process.env.GROK_COMPANION_STOP_REVIEW_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : DEFAULT_STOP_REVIEW_TIMEOUT_MS;
}

function runStopReview(cwd, input = {}) {
  const scriptPath =
    process.env.GROK_COMPANION_TEST_STOP_REVIEW_SCRIPT || path.join(SCRIPT_DIR, "grok-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(
    process.execPath,
    [scriptPath, "stop-review-task", "--json", "--budget-ms", String(STOP_REVIEW_BUDGET_MS), prompt],
    {
      cwd,
      env: childEnv,
      encoding: "utf8",
      timeout: stopReviewTimeoutMs()
    }
  );

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Grok review task timed out after 10 minutes. Run /grok:review --wait manually or bypass the gate."
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    // Classified below after checking the subprocess status.
  }
  if (payload?.brokerBusy === true || payload?.status === "broker-busy") {
    return { ok: true, busy: true, reason: null };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Grok review task failed: ${detail}`
        : "The stop-time Grok review task failed. Run /grok:review --wait manually or bypass the gate."
    };
  }
  if (!payload) {
    return {
      ok: false,
      reason: "The stop-time Grok review task returned invalid JSON. Run /grok:review --wait manually or bypass the gate."
    };
  }
  return parseStopReviewOutput(payload.rawOutput);
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const { busy, runningNote } = describeRunningJobs(listJobs(workspaceRoot), input);

  if (!config.stopReviewGate) {
    logNote(runningNote);
    return;
  }
  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningNote);
    return;
  }
  if (busy) {
    logNote(runningNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (review.busy) {
    logNote(runningNote);
    return;
  }
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningNote ? `${runningNote} ${review.reason}` : review.reason
    });
    return;
  }
  logNote(runningNote);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
