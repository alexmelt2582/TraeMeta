import assert from "node:assert/strict";
import test from "node:test";

import {
  decideWatchdogAction,
  isProcessAlive,
  isManagedProcessImage,
  isManagedProcessCommand,
  normalizePid,
  parseHealth,
  parsePidFile,
  pruneRotatedLogs,
  rotatedLogPath,
  shouldLogRecovery,
  shouldRotateLog,
  summarizeStatus,
} from "../src/lib/service-control.js";

test("pid normalization rejects sentinel and malformed values", () => {
  assert.equal(normalizePid("54776"), 54776);
  assert.equal(normalizePid(54776), 54776);
  assert.equal(normalizePid(" 54776 \n"), 54776);
  assert.equal(normalizePid("unknown"), null);
  assert.equal(normalizePid("0"), null);
  assert.equal(normalizePid("-1"), null);
  assert.equal(normalizePid("1.5"), 1);
  assert.equal(normalizePid(""), null);
  assert.equal(normalizePid(null), null);
  assert.equal(normalizePid(undefined), null);
});

test("process ownership requires both a managed image and the expected command line", () => {
  assert.equal(
    isManagedProcessCommand("node D:\\app\\scripts\\watchdog.js --quiet", "supervisor"),
    true,
  );
  assert.equal(
    isManagedProcessCommand(
      "D:\\app\\TraeMeta.exe --internal-daemon",
      "daemon",
      { bundled: true },
    ),
    true,
  );
  assert.equal(
    isManagedProcessCommand("node D:\\other\\server.js", "daemon"),
    false,
  );
  assert.equal(
    isManagedProcessCommand("D:\\app\\TraeMeta.exe --internal-watchdog", "daemon", {
      bundled: true,
    }),
    false,
  );
  assert.equal(
    isManagedProcessCommand(
      'powershell.exe -File "D:\\app\\scripts\\tray.ps1" -ConfigPath "D:\\data\\tray.json"',
      "tray",
    ),
    true,
  );
  assert.equal(isManagedProcessCommand(null, "daemon"), false);
});

test("pid files only accept a single numeric first line", () => {
  assert.equal(parsePidFile("1234\n"), 1234);
  assert.equal(parsePidFile("1234"), 1234);
  assert.equal(parsePidFile("\r\n1234"), null);
  assert.equal(parsePidFile("pid=1234"), null);
  assert.equal(parsePidFile("unknown"), null);
  assert.equal(parsePidFile(""), null);
  assert.equal(parsePidFile(null), null);
});

test("health payloads without a trustworthy pid are rejected", () => {
  const valid = parseHealth({
    ok: true,
    name: "Trae Meta",
    pid: 54776,
    accountCount: 3,
    keepaliveEnabled: true,
    cdpConnected: true,
    version: "1.0.0",
  });
  assert.deepEqual(valid, {
    pid: 54776,
    accountCount: 3,
    keepaliveEnabled: true,
    cdpConnected: true,
    version: "1.0.0",
  });

  assert.equal(parseHealth({ ok: true }), null);
  assert.equal(parseHealth({ ok: true, name: "Other Service", pid: 1 }), null);
  assert.equal(parseHealth({ ok: true, pid: "unknown" }), null);
  assert.equal(parseHealth({ ok: false, pid: 1 }), null);
  assert.equal(parseHealth(null), null);
  assert.equal(parseHealth([{ ok: true, pid: 1 }]), null);
});

test("only this project's source and bundled process images are managed", () => {
  assert.equal(isManagedProcessImage("node"), true);
  assert.equal(isManagedProcessImage("TraeMeta"), true);
  assert.equal(isManagedProcessImage("trae-meta"), true);
  assert.equal(isManagedProcessImage("powershell"), true);
  assert.equal(isManagedProcessImage("Trae CN"), false);
  assert.equal(isManagedProcessImage(null), false);
});

test("the current process counts as alive and an impossible pid does not", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive("unknown"), false);
  assert.equal(isProcessAlive(0), false);
});

test("watchdog waits while the daemon is healthy", () => {
  assert.deepEqual(
    decideWatchdogAction({
      healthOk: true,
      consecutiveFailures: 9,
      failureThreshold: 3,
      lastStartAtMs: 0,
      nowMs: 1_000_000,
      cooldownMs: 60_000,
    }),
    { action: "sleep", reason: "healthy" },
  );
});

test("watchdog ignores failures below the threshold", () => {
  assert.deepEqual(
    decideWatchdogAction({
      healthOk: false,
      consecutiveFailures: 2,
      failureThreshold: 3,
      lastStartAtMs: null,
      nowMs: 1_000_000,
      cooldownMs: 60_000,
    }),
    { action: "sleep", reason: "below-threshold" },
  );
});

test("watchdog restarts an unhealthy daemon once the threshold is reached", () => {
  assert.deepEqual(
    decideWatchdogAction({
      healthOk: false,
      consecutiveFailures: 3,
      failureThreshold: 3,
      lastStartAtMs: null,
      nowMs: 1_000_000,
      cooldownMs: 60_000,
    }),
    { action: "start", reason: "unhealthy" },
  );
});

test("watchdog backs off during the cooldown window", () => {
  assert.deepEqual(
    decideWatchdogAction({
      healthOk: false,
      consecutiveFailures: 5,
      failureThreshold: 3,
      lastStartAtMs: 990_000,
      nowMs: 1_000_000,
      cooldownMs: 60_000,
    }),
    { action: "sleep", reason: "cooldown" },
  );
  assert.deepEqual(
    decideWatchdogAction({
      healthOk: false,
      consecutiveFailures: 5,
      failureThreshold: 3,
      lastStartAtMs: 900_000,
      nowMs: 1_000_000,
      cooldownMs: 60_000,
    }),
    { action: "start", reason: "unhealthy" },
  );
});

test("a recovery is reported once the daemon answers again", () => {
  assert.equal(
    shouldLogRecovery({ healthOk: true, restartPending: true, consecutiveFailures: 0 }),
    true,
  );
  assert.equal(
    shouldLogRecovery({ healthOk: true, restartPending: false, consecutiveFailures: 2 }),
    true,
  );
});

test("a healthy daemon that never failed is not reported as a recovery", () => {
  assert.equal(
    shouldLogRecovery({ healthOk: true, restartPending: false, consecutiveFailures: 0 }),
    false,
  );
  assert.equal(
    shouldLogRecovery({ healthOk: true, restartPending: false }),
    false,
  );
});

test("an unreachable daemon is never reported as recovered", () => {
  assert.equal(
    shouldLogRecovery({ healthOk: false, restartPending: true, consecutiveFailures: 5 }),
    false,
  );
  assert.equal(
    shouldLogRecovery({ healthOk: false, restartPending: false, consecutiveFailures: 0 }),
    false,
  );
});

test("log rotation only triggers at or above the size limit", () => {
  assert.equal(shouldRotateLog(1023, 1024), false);
  assert.equal(shouldRotateLog(1024, 1024), true);
  assert.equal(shouldRotateLog(2048, 1024), true);
  assert.equal(shouldRotateLog(Number.NaN, 1024), false);
  assert.equal(shouldRotateLog(10, 0), false);
});

test("rotated logs keep the newest entries and drop the rest", () => {
  assert.deepEqual(
    pruneRotatedLogs(
      [
        "watchdog.log.2026-09-14T06-00-00.bak",
        "watchdog.log.2026-09-14T08-00-00.bak",
        "watchdog.log.2026-09-14T07-00-00.bak",
      ],
      2,
    ),
    ["watchdog.log.2026-09-14T06-00-00.bak"],
  );
  assert.deepEqual(pruneRotatedLogs(null), []);
});

test("status summary never reports a pid it does not have", () => {
  const stopped = summarizeStatus({
    health: null,
    watchdogPid: null,
    autostartInstalled: false,
    logPath: "logs/watchdog.log",
  });
  assert.equal(stopped.daemon, "stopped");
  assert.equal(stopped.daemonPid, null);
  assert.equal(stopped.watchdog, "stopped");
  assert.equal(stopped.autostart, "absent");

  const running = summarizeStatus({
    health: parseHealth({
      ok: true,
      name: "Trae Meta",
      pid: 42,
      accountCount: 3,
    }),
    watchdogPid: 99,
    autostartInstalled: true,
    logPath: "logs/watchdog.log",
  });
  assert.equal(running.daemon, "running");
  assert.equal(running.daemonPid, 42);
  assert.equal(running.watchdogPid, 99);
  assert.equal(running.autostart, "installed");
});

test("rotated log names are derived from the active log path", () => {
  assert.equal(
    rotatedLogPath("logs/watchdog.log", "2026-09-14T06-00-00"),
    "logs/watchdog.log.2026-09-14T06-00-00.bak",
  );
});
