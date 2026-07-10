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
    "ACP session loading is not enabled, so use the current workspace and the prior final message as context.",
    "",
    "Prior final message:",
    priorMessage,
    "",
    prompt || DEFAULT_CONTINUE_PROMPT
  ].join("\n");
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
        emitProgress(options.onProgress, progress.message, progress.phase, { threadId: sessionId });
        break;
      }

      case "tool_call_update": {
        const progress = buildToolProgress(update, toolCalls, true);
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
    requiresOpenaiAuth: null,
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
  const forceDirect = Boolean(model || options.effort);
  const previousSession = options.resumeThreadId ? getLastTaskSession(cwd) : null;
  const effectivePrompt = options.resumeThreadId
    ? buildResumePrompt(options.resumeThreadId, previousSession, prompt || DEFAULT_CONTINUE_PROMPT)
    : prompt;

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
      requestTimeoutMs: options.requestTimeoutMs,
      initializeTimeoutMs: options.initializeTimeoutMs,
      sandbox,
      model,
      effort: options.effort ?? null
    },
    async (client) => {
      const session = await client.request("session/new", {
        cwd,
        mcpServers: options.mcpServers ?? [],
        _meta: buildSessionMeta(cwd, {
          ...options,
          brokerRouting:
            client.transport === "broker"
              ? {
                  access: sandbox,
                  ...(Number.isFinite(options.budgetMs) && options.budgetMs > 0
                    ? { budgetMs: Math.floor(options.budgetMs) }
                    : {})
                }
              : null
        })
      });
      const threadId = session.sessionId;
      if (!threadId) {
        throw new Error("Grok ACP session/new did not return a sessionId.");
      }
      emitProgress(options.onProgress, `Session ready (${threadId}).`, "starting", { threadId });

      const turn = await capturePrompt(client, threadId, effectivePrompt, options);
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
        status: turn.stopReason === "end_turn" ? 0 : 1,
        threadId,
        turnId: null,
        finalMessage: turn.finalMessage,
        reasoningSummary: turn.reasoningSummary,
        turn: {
          id: null,
          status: turn.stopReason === "end_turn" ? "completed" : turn.stopReason
        },
        stopReason: turn.stopReason,
        cancelled: turn.stopReason === "cancelled",
        budgetExpired: turn.budgetExpired,
        error: null,
        stderr: client.stderr.trim(),
        fileChanges: [],
        touchedFiles: [],
        commandExecutions: turn.toolCalls,
        plan: turn.plan,
        transport: client.transport
      };
    }
  );
}

export async function runAcpReview(cwd, options = {}) {
  const schema = readOutputSchema(options.schemaPath ?? REVIEW_SCHEMA_PATH);
  const template = loadPromptTemplate(PLUGIN_ROOT, "review");
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

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
