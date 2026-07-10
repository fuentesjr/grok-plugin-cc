import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

export const BROKER_ENDPOINT_ENV = "GROK_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const STDERR_TAIL_MAX_BYTES = 16 * 1024;
const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: {
      readTextFile: false,
      writeTextFile: false
    }
  }
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = new Error(message);
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function appendStderr(existing, chunk) {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, "utf8") <= STDERR_TAIL_MAX_BYTES) {
    return combined;
  }
  return Buffer.from(combined, "utf8").subarray(-STDERR_TAIL_MAX_BYTES).toString("utf8");
}

function directExitError(code, signal, stderr) {
  if (code === 0) {
    return null;
  }
  const exitLabel = signal ? `signal ${signal}` : `exit ${code}`;
  const tail = stderr.trim();
  return createProtocolError(
    `grok ACP process exited unexpectedly (${exitLabel}).${tail ? `\nRaw Grok stderr tail:\n${tail}` : ""}`
  );
}

export function buildGrokAgentArgs(options = {}) {
  const args = [];
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  args.push("agent");
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  args.push("--no-leader", "--always-approve", "stdio");
  return args;
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request(method, params = {}, options = {}) {
    if (this.closed) {
      throw new Error("grok ACP client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(createProtocolError(`Timed out waiting for grok ACP ${method} after ${timeoutMs}ms.`, {
          code: -32000,
          method,
          timeoutMs
        }));
      }, timeoutMs);
      timeout.unref?.();

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse grok ACP JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `grok ACP ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;
    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("grok ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedGrokAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const args = buildGrokAgentArgs({
      sandbox: this.options.sandbox ?? "read-only",
      model: this.options.model ?? null,
      effort: this.options.effort ?? null
    });
    this.proc = spawn(this.options.binary ?? "grok", args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = appendStderr(this.stderr, chunk);
    });
    this.proc.stdin.on("error", (error) => {
      this.handleExit(error);
    });
    this.proc.on("error", (error) => {
      this.handleExit(error);
    });
    this.proc.on("exit", (code, signal) => {
      this.handleExit(directExitError(code, signal, this.stderr));
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", this.options.initializeParams ?? INITIALIZE_PARAMS, {
      timeoutMs: this.options.initializeTimeoutMs ?? this.requestTimeoutMs
    });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    this.readline?.close();

    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (!this.proc || this.proc.exitCode !== null || this.proc.killed) {
          return;
        }
        try {
          terminateProcessTree(this.proc.pid);
        } catch {
          this.proc.kill("SIGTERM");
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("grok ACP stdin is not available.");
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

class BrokerGrokAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", this.options.initializeParams ?? INITIALIZE_PARAMS, {
      timeoutMs: this.options.initializeTimeoutMs ?? this.requestTimeoutMs
    });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    this.socket?.end();
    await this.exitPromise;
  }

  sendMessage(message) {
    if (!this.socket) {
      throw new Error("grok ACP broker connection is not connected.");
    }
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

async function initializeClient(client) {
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function shouldRetryBrokerDirect(error) {
  return error?.rpcCode === BROKER_BUSY_RPC_CODE || error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
}

export class GrokAcpClient {
  static async connect(cwd, options = {}) {
    const forceDirect = Boolean(options.disableBroker || options.model || options.effort);
    let brokerEndpoint = null;

    if (!forceDirect) {
      const env = options.env ?? process.env;
      brokerEndpoint = options.brokerEndpoint ?? env?.[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, {
          env,
          timeoutMs: options.brokerTimeoutMs
        });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }

    if (brokerEndpoint) {
      const brokerClient = new BrokerGrokAcpClient(cwd, { ...options, brokerEndpoint });
      try {
        return await initializeClient(brokerClient);
      } catch (error) {
        if (options.brokerFallback === false || !shouldRetryBrokerDirect(error)) {
          throw error;
        }
      }
    }

    return initializeClient(new SpawnedGrokAcpClient(cwd, options));
  }
}
