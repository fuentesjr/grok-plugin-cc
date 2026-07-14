#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import {
  BROKER_BUSY_RPC_CODE,
  BROKER_SESSION_META_KEY,
  GrokAcpClient
} from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const VALID_ACCESS_LEVELS = new Set(["read-only", "workspace"]);
const DEFAULT_JOB_BUDGET_MS = 20 * 60 * 1000;

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function requiredRules(cwd) {
  return [
    "Do not run `git commit` or `git push`.",
    `Stay inside the workspace at ${cwd}.`,
    "Do not modify files outside that workspace."
  ];
}

function mergeStandingRules(cwd, existingRules) {
  const existing = typeof existingRules === "string" ? existingRules.trim() : "";
  const missing = requiredRules(cwd).filter((rule) => !existing.includes(rule));
  return [...missing, existing].filter(Boolean).join("\n");
}

function extractRouting(params) {
  const meta = params?._meta && typeof params._meta === "object" ? { ...params._meta } : {};
  const declaration =
    meta[BROKER_SESSION_META_KEY] && typeof meta[BROKER_SESSION_META_KEY] === "object"
      ? meta[BROKER_SESSION_META_KEY]
      : {};
  delete meta[BROKER_SESSION_META_KEY];

  const access = VALID_ACCESS_LEVELS.has(declaration.access) ? declaration.access : "read-only";
  const budgetMs =
    Number.isFinite(declaration.budgetMs) && declaration.budgetMs > 0
      ? Math.floor(declaration.budgetMs)
      : DEFAULT_JOB_BUDGET_MS;
  return { access, budgetMs, meta };
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });
  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const sockets = new Set();
  const children = new Map();
  const sessionOwners = new Map();
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let shuttingDown = false;

  function removeChildSessions(profile) {
    for (const [sessionId, owner] of sessionOwners) {
      if (owner.profile !== profile) {
        continue;
      }
      if (owner.budgetTimer) {
        clearTimeout(owner.budgetTimer);
      }
      sessionOwners.delete(sessionId);
    }
  }

  function markChildDead(profile, child, error) {
    if (children.get(profile) === child) {
      children.delete(profile);
      removeChildSessions(profile);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`Grok ${profile} ACP child died: ${detail}`);
  }

  function routeNotification(profile, message) {
    const sessionId = message.params?.sessionId ?? null;
    const owner = sessionId ? sessionOwners.get(sessionId) : null;
    const target = owner ? owner.socket : activeRequestSocket ?? activeStreamSocket;
    if (target) {
      send(target, message);
    }
  }

  async function spawnChild(profile) {
    const client = await GrokAcpClient.connect(cwd, {
      disableBroker: true,
      sandbox: profile,
      env: process.env
    });
    const child = { profile, client };
    client.setNotificationHandler((message) => routeNotification(profile, message));
    children.set(profile, child);
    return child;
  }

  async function getChild(profile) {
    const existing = children.get(profile);
    if (existing && !existing.client.exitResolved) {
      return existing;
    }
    if (existing) {
      children.delete(profile);
      removeChildSessions(profile);
      await existing.client.close().catch(() => {});
    }
    return spawnChild(profile);
  }

  async function requestChild(child, method, params) {
    try {
      return await child.client.request(method, params);
    } catch (error) {
      if (child.client.exitResolved) {
        throw markChildDead(child.profile, child, error);
      }
      throw error;
    }
  }

  function clearRequestOwnership(socket, streaming = false) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (streaming && activeStreamSocket === socket) {
      activeStreamSocket = null;
    }
  }

  function startBudget(owner, sessionId) {
    if (owner.budgetTimer) {
      clearTimeout(owner.budgetTimer);
    }
    owner.budgetExpired = false;
    owner.budgetTimer = setTimeout(() => {
      owner.budgetExpired = true;
      owner.child.client.notify("session/cancel", { sessionId });
    }, owner.budgetMs);
    owner.budgetTimer.unref?.();
  }

  function clearBudget(owner) {
    if (owner?.budgetTimer) {
      clearTimeout(owner.budgetTimer);
      owner.budgetTimer = null;
    }
  }

  function rememberSessionOwner(sessionId, socket, child, routing) {
    sessionOwners.set(sessionId, {
      profile: routing.access,
      child,
      socket,
      budgetMs: routing.budgetMs,
      budgetTimer: null,
      budgetExpired: false,
      inFlight: false
    });
  }

  async function routeSessionOpen(socket, message, method) {
    const routing = extractRouting(message.params ?? {});
    const child = await getChild(routing.access);
    const forwardedParams = {
      ...(message.params ?? {}),
      _meta: {
        ...routing.meta,
        rules: mergeStandingRules(message.params?.cwd ?? cwd, routing.meta.rules)
      }
    };
    const result = await requestChild(child, method, forwardedParams);
    const sessionId = result?.sessionId ?? message.params?.sessionId ?? null;
    if (!sessionId) {
      throw new Error(`Grok ACP ${method} did not return a sessionId.`);
    }
    rememberSessionOwner(sessionId, socket, child, routing);
    return result?.sessionId ? result : { ...(result ?? {}), sessionId };
  }

  async function routeRequest(socket, message) {
    if (message.method === "session/new" || message.method === "session/load") {
      return routeSessionOpen(socket, message, message.method);
    }

    const sessionId = message.params?.sessionId ?? null;
    const owner = sessionId ? sessionOwners.get(sessionId) : null;
    if (!owner) {
      throw new Error(`No broker child owns Grok session ${sessionId ?? "(missing)"}.`);
    }
    if (owner.socket !== socket) {
      throw new Error(`Socket does not own Grok session ${sessionId}.`);
    }

    if (message.method === "session/prompt") {
      owner.inFlight = true;
      startBudget(owner, sessionId);
      try {
        const result = await requestChild(owner.child, message.method, message.params ?? {});
        return owner.budgetExpired
          ? {
              ...result,
              _meta: {
                ...(result?._meta ?? {}),
                brokerBudgetExpired: true
              }
            }
          : result;
      } finally {
        owner.inFlight = false;
        clearBudget(owner);
      }
    }

    return requestChild(owner.child, message.method, message.params ?? {});
  }

  async function routeCancel(socket, message) {
    const sessionId = message.params?.sessionId ?? null;
    const owner = sessionId ? sessionOwners.get(sessionId) : null;
    if (!owner || owner.socket !== socket) {
      return;
    }
    owner.child.client.notify("session/cancel", { sessionId });
  }

  let server;
  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const owner of sessionOwners.values()) {
      clearBudget(owner);
    }
    for (const socket of sockets) {
      socket.end();
    }
    await Promise.all([...children.values()].map((child) => child.client.close().catch(() => {})));
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  await getChild("read-only");

  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: false, audio: false, embeddedContext: false }
              },
              _meta: { broker: "grok-companion" }
            }
          });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown();
          process.exit(0);
        }

        if (message.id === undefined && message.method === "session/cancel") {
          await routeCancel(socket, message);
          continue;
        }

        if (message.id === undefined) {
          continue;
        }

        if (
          (activeRequestSocket && activeRequestSocket !== socket) ||
          (activeStreamSocket && activeStreamSocket !== socket)
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Grok ACP broker is busy.")
          });
          continue;
        }

        const streaming = message.method === "session/prompt";
        activeRequestSocket = socket;
        if (streaming) {
          activeStreamSocket = socket;
        }

        try {
          const result = await routeRequest(socket, message);
          send(socket, { id: message.id, result });
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
        } finally {
          clearRequestOwnership(socket, streaming);
        }
      }
    });

    function handleSocketDisconnect() {
      sockets.delete(socket);
      clearRequestOwnership(socket, true);
      for (const [sessionId, owner] of sessionOwners) {
        if (owner.socket !== socket) {
          continue;
        }
        owner.socket = null;
        if (owner.inFlight) {
          owner.child.client.notify("session/cancel", { sessionId });
        }
      }
    }

    socket.on("close", handleSocketDisconnect);
    socket.on("error", handleSocketDisconnect);
  });

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
    fs.unlinkSync(listenTarget.path);
  }
  await new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);
    server.once("error", handleError);
    server.listen(listenTarget.path, () => {
      server.off("error", handleError);
      resolve();
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
