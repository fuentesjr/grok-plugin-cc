import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default attempts for concurrent truncate/rename windows on shared JSON files. */
export const JSON_READ_MAX_ATTEMPTS = 4;
/** Delay between JSON read retries (ms). */
export const JSON_READ_RETRY_DELAY_MS = 5;

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "grok-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/**
 * Read and parse a JSON file. Retries briefly on empty/partial content so a
 * concurrent non-atomic writer (or a rename mid-flight on some FS) does not
 * surface as a bare `JSON.parse` SyntaxError.
 */
export function readJsonFile(filePath, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? JSON_READ_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? JSON_READ_RETRY_DELAY_MS));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      if (raw === "") {
        throw new SyntaxError("Unexpected end of JSON input");
      }
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      sleepSync(retryDelayMs);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to read JSON file ${filePath}: ${detail}`, { cause: lastError });
}

/**
 * Write JSON via temp file + rename so concurrent readers never observe an
 * empty truncate window (POSIX O_TRUNC). Temp file is in the same directory
 * so rename is atomic on the same filesystem.
 */
export function writeJsonFileAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Best-effort temp cleanup only.
    }
    throw error;
  }
}

export function writeJsonFile(filePath, value) {
  writeJsonFileAtomic(filePath, value);
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
