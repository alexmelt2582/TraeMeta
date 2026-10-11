/**
 * Pure decision helpers for the background watchdog and the service CLI.
 * Everything here is synchronous and side-effect free so it can be unit
 * tested without touching the daemon, the network, or the file system.
 */
import { APP_NAME } from "../constants.js";

const MAX_LOG_BACKUPS = 3;
const MANAGED_IMAGE_NAMES = new Set([
  "node",
  "powershell",
  "pwsh",
  "trae-meta",
  "traemeta",
]);

export function normalizePid(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePidFile(text) {
  if (typeof text !== "string") return null;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const match = /^\s*(\d{1,10})\s*$/.exec(firstLine);
  return match ? normalizePid(match[1]) : null;
}

/**
 * The daemon health payload is the only trusted source for the live pid, so a
 * malformed pid must not be treated as "the daemon is up".
 */
export function parseHealth(payload, { expectedName = APP_NAME } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.ok !== true) return null;
  if (payload.name !== expectedName) return null;
  const pid = normalizePid(payload.pid);
  if (pid === null) return null;
  const accountCount = Number.isInteger(payload.accountCount) ? payload.accountCount : null;
  return {
    pid,
    accountCount,
    keepaliveEnabled: payload.keepaliveEnabled === true,
    cdpConnected: payload.cdpConnected === true,
    version: typeof payload.version === "string" ? payload.version : null,
  };
}

export function isManagedProcessImage(name) {
  if (typeof name !== "string") return false;
  return MANAGED_IMAGE_NAMES.has(name.trim().toLowerCase());
}

export function isManagedProcessCommand(commandLine, kind, { bundled = false } = {}) {
  if (typeof commandLine !== "string" || !commandLine.trim()) return false;
  const command = commandLine.replaceAll("/", "\\").toLowerCase();
  if (kind === "daemon") {
    return bundled ? command.includes("--internal-daemon") : command.includes("daemon.js");
  }
  if (kind === "supervisor") {
    return bundled ? command.includes("--internal-watchdog") : command.includes("watchdog.js");
  }
  if (kind === "tray") return command.includes("tray.ps1");
  return false;
}

export function isProcessAlive(pid) {
  const normalized = normalizePid(pid);
  if (normalized === null) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The watchdog never kills anything, it only decides whether to spawn the
 * daemon again. A cooldown keeps a permanently broken daemon from being
 * respawned in a tight loop.
 */
export function decideWatchdogAction({
  healthOk,
  consecutiveFailures,
  failureThreshold,
  lastStartAtMs,
  nowMs,
  cooldownMs,
}) {
  if (healthOk) return { action: "sleep", reason: "healthy" };
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    return { action: "sleep", reason: "invalid-state" };
  }
  if (consecutiveFailures < failureThreshold) {
    return { action: "sleep", reason: "below-threshold" };
  }
  if (lastStartAtMs !== null && nowMs - lastStartAtMs < cooldownMs) {
    return { action: "sleep", reason: "cooldown" };
  }
  return { action: "start", reason: "unhealthy" };
}

/**
 * A restart resets the failure counter, so the counter alone cannot tell
 * whether the daemon recovered afterwards. `restartPending` carries that fact
 * across polls so a recovery is always reported exactly once.
 */
export function shouldLogRecovery({ healthOk, restartPending, consecutiveFailures }) {
  if (healthOk !== true) return false;
  if (restartPending === true) return true;
  return Number.isInteger(consecutiveFailures) && consecutiveFailures > 0;
}

export function shouldRotateLog(sizeBytes, maxBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return false;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  return sizeBytes >= maxBytes;
}

export function rotatedLogPath(logPath, stamp) {
  return `${logPath}.${stamp}.bak`;
}

/**
 * Keeps the newest `keep` rotated logs and returns the ones that should be
 * removed, newest first by embedded stamp.
 */
export function pruneRotatedLogs(names, keep = MAX_LOG_BACKUPS) {
  if (!Array.isArray(names)) return [];
  const sorted = [...names].sort().reverse();
  return sorted.slice(keep);
}

export function summarizeStatus({ health, watchdogPid, autostartInstalled, logPath }) {
  return {
    daemon: health ? "running" : "stopped",
    daemonPid: health?.pid ?? null,
    cdpConnected: health?.cdpConnected ?? false,
    accountCount: health?.accountCount ?? null,
    keepaliveEnabled: health?.keepaliveEnabled ?? false,
    watchdog: watchdogPid ? "running" : "stopped",
    watchdogPid: watchdogPid ?? null,
    autostart: autostartInstalled ? "installed" : "absent",
    logPath,
  };
}
