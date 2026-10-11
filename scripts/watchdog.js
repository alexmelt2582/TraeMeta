#!/usr/bin/env node
/**
 * Background supervisor for the loopback daemon.
 *
 * This process only ever *starts* the daemon. It never terminates anything:
 * AGENTS.md forbids broad process termination, and an unhealthy daemon is
 * resolved by spawning a replacement only after the health probe has failed
 * repeatedly and the cooldown has elapsed.
 *
 * The daemon's stdout/stderr stay detached (`stdio: "ignore"`) on purpose so
 * that no authentication material can ever reach a log file through this path.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { daemonSpec } from "../src/lib/launch-spec.js";
import { stripProxyEnv } from "../src/lib/net-diagnostics.js";
import {
  DATA_DIR,
  HOST,
  LOG_DIR,
  UI_PORT,
  WATCHDOG_LOG_PATH,
  WATCHDOG_PID_PATH,
} from "../src/lib/runtime-paths.js";
import {
  decideWatchdogAction,
  isProcessAlive,
  parseHealth,
  parsePidFile,
  pruneRotatedLogs,
  rotatedLogPath,
  shouldLogRecovery,
  shouldRotateLog,
} from "../src/lib/service-control.js";

const POLL_INTERVAL_MS =
  Number.parseInt(process.env.TRAEMETA_ENHANCER_WATCHDOG_INTERVAL_MS ?? "", 10) || 15_000;
const FAILURE_THRESHOLD = 3;
const START_COOLDOWN_MS = 60_000;
const HEALTH_TIMEOUT_MS = 4_000;
const MAX_LOG_BYTES = 1024 * 1024;
const LOG_PATH = WATCHDOG_LOG_PATH;

const QUIET = process.argv.includes("--quiet");
const ONCE = process.argv.includes("--once");

function say(message) {
  if (!QUIET) console.log(`[watchdog] ${message}`);
}

async function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    try {
      const stat = await fs.stat(LOG_PATH);
      if (shouldRotateLog(stat.size, MAX_LOG_BYTES)) await rotateLog();
    } catch {
      // No existing log yet.
    }
    await fs.appendFile(LOG_PATH, line, "utf8");
  } catch {
    // Logging must never take the supervisor down.
  }
  say(message);
}

async function rotateLog() {
  const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  await fs.rename(LOG_PATH, rotatedLogPath(LOG_PATH, stamp)).catch(() => {});
  const base = `${path.basename(LOG_PATH)}.`;
  const entries = await fs.readdir(LOG_DIR).catch(() => []);
  for (const name of pruneRotatedLogs(entries.filter((entry) => entry.startsWith(base)), 3)) {
    await fs.rm(path.join(LOG_DIR, name), { force: true }).catch(() => {});
  }
}

async function readHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${HOST}:${UI_PORT}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseHealth(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function startDaemon() {
  const launch = daemonSpec();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...stripProxyEnv(process.env),
      TRAEMETA_ENHANCER_UI_PORT: String(UI_PORT),
    },
  });
  child.unref();
  return child.pid ?? null;
}

async function claimSingleInstance() {
  await fs.mkdir(path.dirname(WATCHDOG_PID_PATH), { recursive: true });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const handle = await fs.open(WATCHDOG_PID_PATH, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return null;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const text = await fs.readFile(WATCHDOG_PID_PATH, "utf8").catch(() => null);
      const existing = parsePidFile(text);
      if (!existing && attempt < 3) {
        await delay(20 + Math.floor(Math.random() * 30));
        continue;
      }
      if (existing && existing !== process.pid && isProcessAlive(existing)) {
        return existing;
      }
      const current = await fs.readFile(WATCHDOG_PID_PATH, "utf8").catch(() => null);
      if (current !== null && current === text) {
        await fs.rm(WATCHDOG_PID_PATH, { force: true }).catch(() => {});
      }
      await delay(20 + Math.floor(Math.random() * 30));
    }
  }
  throw new Error("unable to claim the watchdog pid file");
}

async function releaseSingleInstance() {
  const existing = await fs
    .readFile(WATCHDOG_PID_PATH, "utf8")
    .then(parsePidFile)
    .catch(() => null);
  if (existing === process.pid) await fs.rm(WATCHDOG_PID_PATH, { force: true }).catch(() => {});
}

async function main() {
  const alreadyRunning = await claimSingleInstance();
  if (alreadyRunning) {
    say(`another watchdog is already running (pid ${alreadyRunning}); exiting`);
    return;
  }

  let stopping = false;
  let consecutiveFailures = 0;
  let lastStartAtMs = null;
  let restartPending = false;
  let resolveStopSignal = null;
  let stopSignalResolved = false;
  const stopSignal = new Promise((resolve) => {
    resolveStopSignal = resolve;
  });

  const stop = () => {
    stopping = true;
    if (!stopSignalResolved) {
      stopSignalResolved = true;
      resolveStopSignal();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  say(`supervising http://${HOST}:${UI_PORT} every ${POLL_INTERVAL_MS}ms`);
  await appendLog(`watchdog started pid=${process.pid} port=${UI_PORT}`);

  try {
    do {
      const health = await readHealth();
      if (
        shouldLogRecovery({
          healthOk: Boolean(health),
          restartPending,
          consecutiveFailures,
        })
      ) {
        await appendLog(`daemon is healthy pid=${health.pid}`);
        restartPending = false;
      }
      consecutiveFailures = health ? 0 : consecutiveFailures + 1;

      const { action, reason } = decideWatchdogAction({
        healthOk: Boolean(health),
        consecutiveFailures,
        failureThreshold: FAILURE_THRESHOLD,
        lastStartAtMs,
        nowMs: Date.now(),
        cooldownMs: START_COOLDOWN_MS,
      });

      if (action === "start") {
        const pid = startDaemon();
        lastStartAtMs = Date.now();
        consecutiveFailures = 0;
        restartPending = true;
        await appendLog(`daemon was not reachable; started pid=${pid ?? "unknown"}`);
      } else if (!health && !ONCE && reason !== "below-threshold") {
        await appendLog(`daemon unreachable (${reason}); waiting`);
      }

      if (ONCE) break;
      if (!stopping) await Promise.race([delay(POLL_INTERVAL_MS), stopSignal]);
    } while (!stopping);
  } finally {
    await releaseSingleInstance();
    await appendLog("watchdog stopped");
  }
}

main().catch(async (error) => {
  await appendLog(`fatal: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
