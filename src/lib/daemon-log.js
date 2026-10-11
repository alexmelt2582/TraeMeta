/**
 * File logging shared by the daemon and the service CLI.
 *
 * A background process used to run with its output discarded, which meant a
 * failure on a user machine left no evidence at all. Writing to a file is only
 * safe if no credential can ever reach it, so every line passes through
 * `redactLogLine` first. The patterns cover the shapes this project actually
 * handles: JWTs, authorization headers, long hex tokens, and named secret
 * assignments.
 *
 * Writes are synchronous on purpose. A process logs a handful of lines per
 * sweep, and the line that matters most is the one written immediately before a
 * crash; an asynchronous queue would lose exactly that line.
 */
import fs from "node:fs";
import path from "node:path";

import { pruneRotatedLogs, rotatedLogPath, shouldRotateLog } from "./service-control.js";

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?/g;
const AUTH_HEADER = /\b((?:bearer|cloud-ide-jwt|cloud-ide-token)\s+)\S+/gi;
const NAMED_SECRET = /\b((?:access_?token|refresh_?token|token|secret|password|passwd|apikey|api_?key|authorization|cookie)\b\s*[=:]\s*)(?!<redacted>)\S+/gi;
const SECRET_QUERY = /([?&](?:did|token|access_token|refresh_token|code|password|secret|key)=)[^&\s"']+/gi;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;

export function redactLogLine(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(JWT, "<redacted-jwt>")
    .replace(AUTH_HEADER, "$1<redacted>")
    .replace(NAMED_SECRET, "$1<redacted>")
    .replace(SECRET_QUERY, "$1<redacted>")
    .replace(LONG_HEX, "<redacted-hex>");
}

/**
 * Formats a log timestamp as Beijing wall-clock time with an explicit offset.
 *
 * `toISOString()` writes UTC, which reads eight hours behind the clock on the
 * user's wall: a line stamped 04:34 for an event that happened at 12:34 is wrong
 * on the one screen this project has for diagnosis. China has observed a fixed
 * UTC+8 offset since 1991, and the project already fixes `Asia/Shanghai` as its
 * calendar timezone, so a constant offset is exact here rather than an
 * approximation. The offset is kept visible so the value stays unambiguous.
 */
export function formatLogTimestamp(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, -1)}+08:00`;
}

function formatArgument(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }
  return String(value);
}

function rotateIfNeeded(logPath, maxBytes, maxBackups) {
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (!shouldRotateLog(size, maxBytes)) return;
  const stamp = formatLogTimestamp().replaceAll(":", "-").slice(0, 19);
  try {
    fs.renameSync(logPath, rotatedLogPath(logPath, stamp));
  } catch {
    return;
  }
  const dir = path.dirname(logPath);
  const base = `${path.basename(logPath)}.`;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of pruneRotatedLogs(entries.filter((entry) => entry.startsWith(base)), maxBackups)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Rotation cleanup is best effort.
    }
  }
}

/**
 * `mirror` keeps the console behaviour for `npm run daemon`; file writes never
 * throw, because logging must not be able to take the daemon down.
 */
export function createDaemonLogger({
  logPath,
  maxBytes = 2 * 1024 * 1024,
  maxBackups = 3,
  mirror = true,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (typeof logPath !== "string" || !logPath.trim()) {
    throw new Error("createDaemonLogger requires a log path");
  }

  function write(level, values) {
    const text = redactLogLine(values.map(formatArgument).join(" "));
    if (mirror) {
      const sink = level === "error" ? stderr : stdout;
      try {
        sink.write(`${text}\n`);
      } catch {
        // Console mirroring is best effort and must never recurse through logger hooks.
      }
    }
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      rotateIfNeeded(logPath, maxBytes, maxBackups);
      fs.appendFileSync(logPath, `[${formatLogTimestamp()}] [${level}] ${text}\n`, "utf8");
    } catch {
      // Logging failure is never fatal.
    }
  }

  return {
    logPath,
    info: (...values) => write("info", values),
    warn: (...values) => write("warn", values),
    error: (...values) => write("error", values),
  };
}
