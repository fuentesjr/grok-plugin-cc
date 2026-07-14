import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BROKER_ENDPOINT_ENV, BROKER_SESSION_META_KEY, GrokAcpClient } from "./acp-client.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";
import { getLastTaskSession, setLastTaskSession } from "./state.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REVIEW_SCHEMA_PATH = fileURLToPath(new URL("../../schemas/review-output.schema.json", import.meta.url));
const FAST_MODEL_ALIAS = "grok-composer-2.5-fast";
const TASK_THREAD_PREFIX = "Grok Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the prior task context. Pick the next highest-value step and follow through until the task is resolved.";
export const DEFAULT_JOB_BUDGET_MS = 20 * 60 * 1000;
/** Extra wall-clock after the productive budget for a wind-down handoff turn. */
export const DEFAULT_BUDGET_GRACE_MS = 90 * 1000;
export const BUDGET_GRACE_PROMPT = [
  "Budget expired.",
  "Stop starting new work immediately.",
  "Write a concise handoff covering: (1) what you completed, (2) what remains unfinished (files/tests/docs), (3) the single next concrete step.",
  "Do not begin new edits or long-running commands."
].join(" ");

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function withTerminalPunctuation(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function contentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((entry) => contentText(entry)).join("");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }
    if ("content" in content) {
      return contentText(content.content);
    }
  }
  return "";
}

function normalizeModel(model) {
  return model === "fast" ? FAST_MODEL_ALIAS : model ?? null;
}

function normalizeSandbox(sandbox) {
  return sandbox === "workspace" || sandbox === "workspace-write" || sandbox === "write"
    ? "workspace"
    : "read-only";
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function isCommandTool(update) {
  return /execute|terminal|shell|command/i.test(String(update?.kind ?? ""));
}

function progressEvent(message, phase = null, extra = {}) {
  return {
    message: String(message ?? "").trim(),
    phase,
    threadId: null,
    turnId: null,
    stderrMessage: null,
    logTitle: null,
    logBody: null,
    ...extra
  };
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  onProgress(progressEvent(message, phase, extra));
}

function planText(update) {
  const entries = Array.isArray(update?.entries) ? update.entries : [];
  const text = entries
    .map((entry) => entry?.content ?? entry?.title ?? entry?.description ?? "")
    .filter(Boolean)
    .join("; ");
  return normalizeText(text || update?.title || update?.description || "plan changed");
}

function toolOutputText(update) {
  return contentText(update?.content).trim();
}

function isEditTool(tool) {
  const metadata = tool?._meta?.["x.ai/tool"];
  return (
    tool?.kind === "edit" ||
    metadata?.kind === "write" ||
    metadata?.kind === "edit" ||
    metadata?.read_only === false
  );
}

function touchedPaths(update, tool) {
  if (!isEditTool(tool)) {
    return [];
  }

  const locationPaths = Array.isArray(update?.locations)
    ? update.locations.map((location) => location?.path).filter(Boolean)
    : [];
  if (locationPaths.length > 0) {
    return locationPaths;
  }

  const diffPaths = Array.isArray(update?.content)
    ? update.content
        .filter((entry) => entry?.type === "diff")
        .map((entry) => entry?.path)
        .filter(Boolean)
    : [];
  if (diffPaths.length > 0) {
    return diffPaths;
  }

  return tool?._meta?.["x.ai/tool"]?.read_only === false && update?.rawInput?.file_path
    ? [update.rawInput.file_path]
    : [];
}

function standingRules(cwd) {
  return [
    "Do not run `git commit` or `git push`.",
    `Stay inside the workspace at ${cwd}.`,
    "Do not modify files outside that workspace."
  ].join("\n");
}

function buildSessionMeta(cwd, options = {}) {
  const extraRules = typeof options.rules === "string" && options.rules.trim() ? `\n${options.rules.trim()}` : "";
  const meta = {
    ...(options.sessionMeta ?? {}),
    rules: `${standingRules(cwd)}${extraRules}`
  };
  if (options.brokerRouting) {
    meta[BROKER_SESSION_META_KEY] = options.brokerRouting;
  }
  return meta;
}

function buildPromptInput(prompt) {
  return [{ type: "text", text: prompt }];
}

function buildResumePrompt(resumeThreadId, previousSession, prompt) {
  const priorMessage = previousSession?.finalMessage?.trim() || "No final message was captured.";
  return [
    `Continue from the prior task context recorded for Grok session ${resumeThreadId}.`,
    "Native ACP session loading was unavailable, so use the current workspace and the prior final message as context.",
    "",
    "Prior final message:",
    priorMessage,
    "",
    prompt || DEFAULT_CONTINUE_PROMPT
  ].join("\n");
}

function isSessionMissingError(error) {
  const text = String(error?.message ?? error ?? "");
  return /not found|unknown session|no such session|does not exist|invalid session|session.*missing/i.test(text);
}

async function openAcpSession(client, cwd, options = {}) {
  const resumeThreadId = options.resumeThreadId ?? null;
  const sessionMeta = buildSessionMeta(cwd, options);
  const baseParams = {
    cwd,
    mcpServers: options.mcpServers ?? [],
    _meta: sessionMeta
  };

  if (resumeThreadId && client.supportsLoadSession) {
    try {
      const loaded = await client.request("session/load", {
        ...baseParams,
        sessionId: resumeThreadId
      });
      const threadId = loaded?.sessionId ?? resumeThreadId;
      return {
        threadId,
        resumed: true,
        mode: "load",
        prompt: options.prompt || DEFAULT_CONTINUE_PROMPT
      };
    } catch (error) {
      if (!isSessionMissingError(error) && !/session\/load|loadSession|unsupported method/i.test(String(error?.message ?? ""))) {
        // Unexpected load failures still fall back to a seeded new session.
      }
      emitProgress(
        options.onProgress,
        `Native session load failed (${error instanceof Error ? error.message : String(error)}); seeding a fresh session from stored context.`,
        "starting"
      );
    }
  }

  const session = await client.request("session/new", baseParams);
  const threadId = session.sessionId;
  if (!threadId) {
    throw new Error("Grok ACP session/new did not return a sessionId.");
  }

  if (resumeThreadId) {
    return {
      threadId,
      resumed: true,
      mode: "seeded-new",
      prompt: buildResumePrompt(resumeThreadId, options.previousSession, options.prompt || DEFAULT_CONTINUE_PROMPT)
    };
  }

  return {
    threadId,
    resumed: false,
    mode: "new",
    prompt: options.prompt
  };
}

async function runBudgetGraceTurn(client, sessionId, options = {}) {
  const graceMs =
    Number.isFinite(options.budgetGraceMs) && options.budgetGraceMs >= 0
      ? Math.floor(options.budgetGraceMs)
      : DEFAULT_BUDGET_GRACE_MS;
  if (graceMs <= 0) {
    return null;
  }

  emitProgress(
    options.onProgress,
    "Budget expired; requesting wind-down handoff.",
    "cancelling",
    { threadId: sessionId }
  );

  try {
    return await capturePrompt(client, sessionId, BUDGET_GRACE_PROMPT, {
      ...options,
      budgetMs: graceMs
    });
  } catch (error) {
    emitProgress(
      options.onProgress,
      `Budget wind-down failed: ${error instanceof Error ? error.message : String(error)}`,
      "cancelling",
      {
        threadId: sessionId,
        stderrMessage: error instanceof Error ? error.message : String(error)
      }
    );
    return null;
  }
}

function mergeGraceTurn(mainTurn, graceTurn) {
  if (!graceTurn) {
    return mainTurn;
  }
  const graceMessage = graceTurn.finalMessage?.trim() ?? "";
  return {
    ...mainTurn,
    finalMessage: graceMessage || mainTurn.finalMessage,
    reasoningSummary: [...(mainTurn.reasoningSummary ?? []), ...(graceTurn.reasoningSummary ?? [])],
    plan: graceTurn.plan ?? mainTurn.plan,
    toolCalls: [...(mainTurn.toolCalls ?? []), ...(graceTurn.toolCalls ?? [])],
    touchedFiles: [...new Set([...(mainTurn.touchedFiles ?? []), ...(graceTurn.touchedFiles ?? [])])],
    // Keep the productive turn's cancellation signal; the job still hit its budget.
    budgetExpired: true,
    stopReason: mainTurn.stopReason,
    graceTurn: {
      stopReason: graceTurn.stopReason,
      finalMessage: graceTurn.finalMessage,
      budgetExpired: graceTurn.budgetExpired
    }
  };
}

function buildToolProgress(update, toolCalls, isUpdate = false) {
  const existing = toolCalls.get(update.toolCallId) ?? {};
  const tool = { ...existing, ...update };
  toolCalls.set(update.toolCallId, tool);
  const title = shorten(tool.title ?? tool.toolCallId ?? "tool", 96);
  const command = isCommandTool(tool);
  const status = String(tool.status ?? "in_progress").toLowerCase();
  const failed = /fail|error|cancel/.test(status);
  const finished = failed || /complete|success/.test(status);

  if (!isUpdate || !finished) {
    return {
      message: command
        ? `Running command: ${withTerminalPunctuation(title)}`
        : `Running tool: ${withTerminalPunctuation(title)}`,
      phase: command && looksLikeVerificationCommand(title) ? "verifying" : "investigating"
    };
  }

  return {
    message: command
      ? `Command ${failed ? "failed" : "completed"}: ${withTerminalPunctuation(title)}`
      : `Tool ${failed ? "failed" : "completed"}: ${withTerminalPunctuation(title)}`,
    phase: failed ? "failed" : command && looksLikeVerificationCommand(title) ? "verifying" : "investigating",
    logTitle: toolOutputText(tool) ? `Tool ${title} output` : null,
    logBody: toolOutputText(tool) || null
  };
}

async function capturePrompt(client, sessionId, prompt, options = {}) {
  let finalMessage = "";
  let reasoningText = "";
  let plan = null;
  const toolCalls = new Map();
  const touchedFiles = new Set();
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    if (message.method !== "session/update" || message.params?.sessionId !== sessionId) {
      previousHandler?.(message);
      return;
    }

    const update = message.params?.update ?? {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        finalMessage += contentText(update.content);
        break;

      case "agent_thought_chunk": {
        const text = contentText(update.content);
        reasoningText += text;
        const normalized = normalizeText(text);
        emitProgress(options.onProgress, `Reasoning: ${withTerminalPunctuation(shorten(normalized))}`, "investigating", {
          threadId: sessionId,
          logTitle: "Reasoning summary",
          logBody: normalized ? `- ${normalized}` : null
        });
        break;
      }

      case "plan": {
        plan = update;
        const text = planText(update);
        emitProgress(options.onProgress, `Plan updated: ${withTerminalPunctuation(shorten(text))}`, "planning", {
          threadId: sessionId,
          logTitle: "Plan",
          logBody: text
        });
        break;
      }

      case "tool_call": {
        const progress = buildToolProgress(update, toolCalls, false);
        const tool = toolCalls.get(update.toolCallId);
        for (const file of touchedPaths(update, tool)) {
          touchedFiles.add(file);
        }
        emitProgress(options.onProgress, progress.message, progress.phase, { threadId: sessionId });
        break;
      }

      case "tool_call_update": {
        const progress = buildToolProgress(update, toolCalls, true);
        const tool = toolCalls.get(update.toolCallId);
        for (const file of touchedPaths(update, tool)) {
          touchedFiles.add(file);
        }
        emitProgress(options.onProgress, progress.message, progress.phase, {
          threadId: sessionId,
          logTitle: progress.logTitle,
          logBody: progress.logBody
        });
        break;
      }

      default:
        previousHandler?.(message);
        break;
    }
  });

  let budgetExpired = false;
  let budgetTimer = null;
  if (Number.isFinite(options.budgetMs) && options.budgetMs > 0) {
    budgetTimer = setTimeout(() => {
      budgetExpired = true;
      emitProgress(options.onProgress, "Budget expired; cancelling turn.", "cancelling", { threadId: sessionId });
      client.notify("session/cancel", { sessionId });
    }, options.budgetMs);
    budgetTimer.unref?.();
  }

  emitProgress(options.onProgress, "Turn started.", "starting", { threadId: sessionId });
  try {
    const response = await client.request("session/prompt", {
      sessionId,
      prompt: buildPromptInput(prompt)
    });
    const stopReason = response.stopReason ?? "unknown";
    const normalizedReasoning = normalizeText(reasoningText);
    if (finalMessage) {
      emitProgress(
        options.onProgress,
        `Assistant message captured: ${withTerminalPunctuation(shorten(finalMessage))}`,
        "finalizing",
        {
          threadId: sessionId,
          logTitle: "Assistant message",
          logBody: finalMessage
        }
      );
    }
    emitProgress(
      options.onProgress,
      stopReason === "cancelled" ? "Turn cancelled." : `Turn completed (${stopReason}).`,
      stopReason === "cancelled" ? "cancelled" : "finalizing",
      { threadId: sessionId }
    );
    return {
      stopReason,
      finalMessage,
      reasoningSummary: normalizedReasoning ? [normalizedReasoning] : [],
      plan,
      toolCalls: [...toolCalls.values()],
      touchedFiles: [...touchedFiles],
      budgetExpired
    };
  } catch (error) {
    emitProgress(options.onProgress, `Grok error: ${error.message}`, "failed", {
      threadId: sessionId,
      stderrMessage: error.message
    });
    throw error;
  } finally {
    if (budgetTimer) {
      clearTimeout(budgetTimer);
    }
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAcpClient(cwd, options, fn) {
  const client = await GrokAcpClient.connect(cwd, options);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "acp",
    authMethod: null,
    verified: null,
    provider: "xai",
    ...fields
  };
}

function isAuthRequiredError(error) {
  return (
    error?.rpcCode === -32003 ||
    error?.data?.kind === "auth_required" ||
    /auth|login|credential|unauthorized/i.test(String(error?.message ?? ""))
  );
}

export function getGrokAvailability(cwd, options = {}) {
  return binaryAvailable("grok", ["--version"], { cwd, env: options.env });
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse the shared Grok ACP runtime.",
      endpoint
    };
  }
  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Grok ACP runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return buildAuthStatus({
      available: false,
      detail: availability.detail,
      source: "availability",
      verified: false
    });
  }

  try {
    return await withAcpClient(
      cwd,
      {
        env: options.env,
        disableBroker: options.disableBroker,
        reuseExistingBroker: options.reuseExistingBroker ?? true,
        requestTimeoutMs: options.requestTimeoutMs
      },
      async (client) => {
        await client.request("session/new", {
          cwd,
          mcpServers: [],
          _meta: buildSessionMeta(cwd)
        });
        return buildAuthStatus({
          loggedIn: true,
          detail: "Grok ACP session creation succeeded.",
          verified: true
        });
      }
    );
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      verified: isAuthRequiredError(error) ? true : false
    });
  }
}

export async function cancelAcpTurn(cwd, { threadId, turnId = null } = {}, options = {}) {
  if (!threadId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId"
    };
  }

  const env = options.env ?? process.env;
  const endpoint = options.brokerEndpoint ?? env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (!endpoint) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "no shared Grok ACP runtime is available for session cancellation"
    };
  }

  let client = null;
  try {
    client = await GrokAcpClient.connect(cwd, {
      env,
      brokerEndpoint: endpoint,
      brokerFallback: false
    });
    client.notify("session/cancel", { sessionId: threadId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Cancelled Grok session ${threadId}${turnId ? ` turn ${turnId}` : ""}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAcpTurn(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(
      `Grok CLI is not installed or unavailable (${availability.detail}). Install Grok Build, run \`grok login\`, then rerun \`/grok:setup\`.`
    );
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt && !options.resumeThreadId) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const model = normalizeModel(options.model);
  const sandbox = normalizeSandbox(options.sandbox);
  const budgetMs =
    Number.isFinite(options.budgetMs) && options.budgetMs > 0
      ? Math.floor(options.budgetMs)
      : DEFAULT_JOB_BUDGET_MS;
  const budgetGraceMs =
    Number.isFinite(options.budgetGraceMs) && options.budgetGraceMs >= 0
      ? Math.floor(options.budgetGraceMs)
      : DEFAULT_BUDGET_GRACE_MS;
  const forceDirect = Boolean(model || options.effort);
  const previousSession = options.resumeThreadId ? getLastTaskSession(cwd) : null;
  const continuePrompt = prompt || (options.resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "");

  emitProgress(
    options.onProgress,
    options.resumeThreadId
      ? "Starting Grok continuation session."
      : options.sessionKind === "review"
        ? "Starting Grok review session."
        : "Starting Grok task session.",
    "starting"
  );

  return withAcpClient(
    cwd,
    {
      env: options.env,
      disableBroker: forceDirect || options.disableBroker,
      reuseExistingBroker: options.reuseExistingBroker,
      brokerEndpoint: options.brokerEndpoint,
      brokerTimeoutMs: options.brokerTimeoutMs,
      brokerFallback: options.brokerFallback,
      requestTimeoutMs: options.requestTimeoutMs,
      initializeTimeoutMs: options.initializeTimeoutMs,
      sandbox,
      model,
      effort: options.effort ?? null,
      onSpawn: options.onProcessSpawn,
      onExit: options.onProcessExit
    },
    async (client) => {
      const brokerRouting =
        client.transport === "broker"
          ? {
              access: sandbox,
              // Broker backstop covers the productive budget plus wind-down grace.
              budgetMs: budgetMs + budgetGraceMs
            }
          : null;
      const opened = await openAcpSession(client, cwd, {
        ...options,
        prompt: continuePrompt,
        previousSession,
        brokerRouting
      });
      const threadId = opened.threadId;
      emitProgress(
        options.onProgress,
        opened.mode === "load"
          ? `Session resumed (${threadId}).`
          : `Session ready (${threadId}).`,
        "starting",
        { threadId }
      );

      let turn = await capturePrompt(client, threadId, opened.prompt, { ...options, budgetMs });
      if (turn.budgetExpired && budgetGraceMs > 0 && options.skipBudgetGrace !== true) {
        const graceTurn = await runBudgetGraceTurn(client, threadId, {
          ...options,
          budgetGraceMs
        });
        turn = mergeGraceTurn(turn, graceTurn);
      }

      if (options.persistThread) {
        setLastTaskSession(cwd, {
          id: threadId,
          name:
            options.threadName ??
            previousSession?.name ??
            buildTaskThreadName(options.prompt || DEFAULT_CONTINUE_PROMPT),
          finalMessage: turn.finalMessage,
          updatedAt: new Date().toISOString()
        });
      }

      return {
        // Budget expiry still fails the job even when wind-down produces a handoff.
        status: turn.budgetExpired ? 1 : turn.stopReason === "end_turn" ? 0 : 1,
        threadId,
        turnId: null,
        finalMessage: turn.finalMessage,
        reasoningSummary: turn.reasoningSummary,
        turn: {
          id: null,
          status: turn.budgetExpired
            ? "budget_expired"
            : turn.stopReason === "end_turn"
              ? "completed"
              : turn.stopReason
        },
        stopReason: turn.stopReason,
        cancelled: turn.stopReason === "cancelled",
        budgetExpired: turn.budgetExpired,
        resumeMode: opened.mode,
        error: null,
        stderr: client.stderr.trim(),
        fileChanges: [],
        touchedFiles: turn.touchedFiles,
        commandExecutions: turn.toolCalls,
        plan: turn.plan,
        transport: client.transport
      };
    }
  );
}

export async function runAcpReview(cwd, options = {}) {
  const schema = readOutputSchema(options.schemaPath ?? REVIEW_SCHEMA_PATH);
  const template = loadPromptTemplate(PLUGIN_ROOT, options.promptName ?? "review");
  const prompt = interpolateTemplate(template, {
    TARGET_LABEL: options.targetLabel ?? options.target?.label ?? "working tree diff",
    USER_FOCUS: options.userFocus ?? options.focusText ?? "(none)",
    REVIEW_COLLECTION_GUIDANCE:
      options.reviewCollectionGuidance ?? options.collectionGuidance ?? "Use the repository context below as primary evidence.",
    REVIEW_INPUT: options.reviewInput ?? options.input ?? options.context?.content ?? ""
  });
  const schemaPrompt = `${prompt.trimEnd()}\n\n<json_schema>\n${JSON.stringify(schema, null, 2)}\n</json_schema>\n`;
  const turn = await runAcpTurn(cwd, {
    ...options,
    prompt: schemaPrompt,
    sandbox: "read-only",
    persistThread: false,
    sessionKind: "review"
  });
  const result = parseStructuredOutput(turn.finalMessage, {
    status: turn.status,
    failureMessage: turn.error?.message ?? turn.stderr,
    reasoningSummary: turn.reasoningSummary
  });
  return {
    ...turn,
    sourceThreadId: turn.threadId,
    reviewText: turn.finalMessage,
    result,
    parsed: result.parsed,
    rawOutput: result.rawOutput,
    parseError: result.parseError
  };
}

export async function findLatestTaskThread(cwd) {
  const session = getLastTaskSession(cwd);
  if (!session?.id) {
    return null;
  }
  return {
    id: session.id,
    name: session.name ?? TASK_THREAD_PREFIX
  };
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const candidates = [rawOutput];
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    candidates.push(fenced);
  }
  const firstBrace = rawOutput.indexOf("{");
  const lastBrace = rawOutput.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(rawOutput.slice(firstBrace, lastBrace + 1));
  }

  let parseError = null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return {
        parsed: JSON.parse(candidate),
        parseError: null,
        rawOutput,
        ...fallback
      };
    } catch (error) {
      parseError = error;
    }
  }

  return {
    parsed: null,
    parseError: parseError?.message ?? "Grok returned invalid JSON.",
    rawOutput,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(path.resolve(schemaPath));
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX, buildResumePrompt };
