import { spawn } from "node:child_process";
import path from "node:path";

import {
  APP_NAME,
  DEFAULT_CDP_PORT,
  DEFAULT_DATA_DIR,
  DEFAULT_TRAE_EXE,
  DEFAULT_TRAE_USER_DATA_DIR,
  DEFAULT_UI_PORT,
  LOOPBACK_HOST,
  parsePort,
} from "./constants.js";
import { daemonSpec } from "./lib/launch-spec.js";
import {
  SOURCES,
  createWindowsProbe,
  formatNotFoundHelp,
  resolveTraeExe,
} from "./lib/trae-locate.js";
import {
  focusTraeWindow,
  isTraeCdpAvailable,
  startTraeWithCdp,
  stopTraeForRestart,
  waitForCdp,
} from "./lib/trae-process.js";
import { readTextFile } from "./lib/json-file.js";
import { stripProxyEnv } from "./lib/net-diagnostics.js";
import { createDaemonLogger } from "./lib/daemon-log.js";
import { LAUNCHER_LOG_PATH } from "./lib/runtime-paths.js";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The shortcut runs this process with no console, so everything written to
 * stdout is discarded and a click that failed leaves no evidence behind. Every
 * line is therefore also appended to `logs/launcher.log`, which is the only
 * place the window-focus outcome can be read back after a real click.
 */
const log = createDaemonLogger({ logPath: LAUNCHER_LOG_PATH });

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cdpPort = parsePort(
  argumentValue("--cdp-port") || process.env.TRAEMETA_ENHANCER_CDP_PORT,
  DEFAULT_CDP_PORT,
);
const uiPort = parsePort(
  argumentValue("--ui-port") || process.env.TRAEMETA_ENHANCER_UI_PORT,
  DEFAULT_UI_PORT,
);
const explicitTraeExe = argumentValue("--trae-exe");
let exePath = explicitTraeExe || process.env.TRAEMETA_ENHANCER_TRAE_EXE || DEFAULT_TRAE_EXE;
const userDataDir =
  argumentValue("--user-data-dir") ||
  process.env.TRAEMETA_ENHANCER_USER_DATA_DIR ||
  DEFAULT_TRAE_USER_DATA_DIR;
const dataDir =
  argumentValue("--data-dir") || process.env.TRAEMETA_ENHANCER_DATA_DIR || DEFAULT_DATA_DIR;
const storagePath =
  process.env.TRAEMETA_ENHANCER_STORAGE_PATH ||
  path.join(userDataDir, "User", "globalStorage", "storage.json");
const noRestart = process.argv.includes("--no-restart");

async function daemonHealth() {
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${uiPort}/api/health`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function startDaemon() {
  const existing = await daemonHealth();
  if (existing?.ok) return existing;

  const launch = daemonSpec();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...stripProxyEnv(process.env),
      TRAEMETA_ENHANCER_CDP_PORT: String(cdpPort),
      TRAEMETA_ENHANCER_UI_PORT: String(uiPort),
      TRAEMETA_ENHANCER_DATA_DIR: dataDir,
      TRAEMETA_ENHANCER_STORAGE_PATH: storagePath,
      TRAEMETA_ENHANCER_USER_DATA_DIR: userDataDir,
    },
  });
  child.unref();

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const health = await daemonHealth();
    if (health?.ok) return health;
    await delay(250);
  }
  throw new Error(`Timed out waiting for the local daemon on port ${uiPort}`);
}

/**
 * Hands one line to the injected panel for it to show as a toast.
 *
 * The shortcut is launched without a console, so a failure on this path has
 * nowhere else to appear; the daemon holds the only CDP connection that can reach
 * the panel, so the message travels through it. Never throws: a notice that could
 * not be delivered must not turn a focus problem into a failed launch.
 */
async function notifyPanel(dataDirPath, token, message) {
  try {
    await fetch(`http://${LOOPBACK_HOST}:${uiPort}/api/notice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-traemeta-enhancer-token": token,
      },
      body: JSON.stringify({ message }),
    });
  } catch (error) {
    log.warn(`[${APP_NAME}] the notice could not be delivered: ${error?.message || error}`);
  }
}

/**
 * The visible result of clicking the shortcut while TRAE is already running.
 *
 * Until now that click did nothing at all: the CDP check passed, the panel was
 * already injected, and the launcher exited without touching a window. Restoring
 * the window is the whole point of the click, so it happens here.
 *
 * The probe compiles a C# helper before it can enumerate windows, which costs
 * over a second by itself, so it is started here and only acted on once the panel
 * exists to report a failure into: the wait overlaps the daemon start and the
 * injection instead of being added to the end of the launch. Nothing here throws
 * — a window that could not be raised is not a failed launch, and reporting it as
 * one would make the shortcut look broken in a way it is not.
 */
async function settleWindowFocus(focus, exePath, dataDirPath, token) {
  // Recorded for every outcome, not only the failures: a click that did nothing
  // visible has to leave behind what the helper actually found, or the next
  // attempt is a guess again.
  log.info(
    `[${APP_NAME}] window focus: ${focus.action}` +
      `${focus.detail ? ` [${focus.detail}]` : ""}` +
      `${focus.error ? ` (${focus.error})` : ""}`,
  );

  if (focus.action !== "no-window" && focus.action !== "unavailable") {
    return;
  }

  if (focus.action === "no-window") {
    // The process is alive but owns no window at all, so there is nothing to
    // restore. Asking the running instance for a new window is the only way to
    // put something on screen, and the single-instance lock keeps this from
    // starting a second TRAE.
    log.info(`[${APP_NAME}] TRAE owns no window; asking the running instance for one...`);
    await startTraeWithCdp(exePath, cdpPort);
    // The request only asks Chromium to create the window; it still has to be
    // created and shown. Sampling once at a fixed delay made a slow start look
    // like a failure and told the user to go find TRAE in the taskbar — while the
    // window was already on screen. Waiting for a window to appear is the
    // question that was actually being asked.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await delay(700);
      const retry = await focusTraeWindow(exePath);
      if (retry.action !== "no-window" && retry.action !== "unavailable") {
        log.info(`[${APP_NAME}] window focus retry: ${retry.action}`);
        return;
      }
    }
    log.info(`[${APP_NAME}] window focus retry: still no window`);
  }

  await notifyPanel(
    dataDirPath,
    token,
    "没能把 TRAE 窗口调到最前面，请到任务栏点一下 TRAE。",
  );
}

async function main() {
  const resolved = await resolveTraeExe({
    dataDir,
    probe: createWindowsProbe(),
    explicit: explicitTraeExe,
  });
  if (!resolved.path) {
    throw new Error(formatNotFoundHelp({ attempts: resolved.attempts, dataDir }));
  }
  exePath = resolved.path;
  log.info(
    `[${APP_NAME}] TRAE: ${exePath} (来源: ${SOURCES[resolved.source] ?? resolved.source})`,
  );

  // Whether TRAE was already up decides what the click means. A restart or a cold
  // start puts a window on screen by itself, so only the already-running case has
  // to be brought forward explicitly.
  const alreadyRunning = await isTraeCdpAvailable(cdpPort);
  // Whether the click is treated as "bring the existing window forward" or as a
  // cold start, and the answer to that decides the whole branch below; it is the
  // first thing to check when a click seems to do nothing.
  log.info(`[${APP_NAME}] TRAE already running with CDP: ${alreadyRunning}`);
  // Started before the daemon and the injection are waited on so its PowerShell
  // round trip runs alongside them; the result is consumed only after injection,
  // when the panel can still be told about a failure. A cold start or a restart
  // puts a window on screen by itself and has nothing to bring forward.
  const focusPromise = alreadyRunning ? focusTraeWindow(exePath) : null;
  let cdpReady = alreadyRunning;
  if (!cdpReady && noRestart) {
    throw new Error(
      `Trae CN is not exposing CDP port ${cdpPort}. Start it through this launcher.`,
    );
  }

  // The daemon only serves the loopback API and connects to CDP once it is up, so
  // its startup does not depend on TRAE being reachable yet. On a cold start it is
  // therefore started alongside the TRAE launch and its result collected after,
  // instead of starting only once CDP is already listening. The two waits are
  // independent and the TRAE launch is the longer of them, so this removes the
  // daemon's own startup from the critical path rather than adding to it.
  let daemonStart = null;
  if (!cdpReady) {
    log.info(`[${APP_NAME}] Restarting Trae CN with CDP port ${cdpPort}...`);
    await stopTraeForRestart(exePath);
    await startTraeWithCdp(exePath, cdpPort);
    daemonStart = startDaemon();
    cdpReady = await waitForCdp(cdpPort);
    if (!cdpReady) {
      throw new Error(`Timed out waiting for Trae CN CDP port ${cdpPort}`);
    }
  }

  const health = daemonStart ? await daemonStart : await startDaemon();
  const token = await getToken(dataDir);
  let lastInjectStatus = 0;
  const injectDeadline = Date.now() + 12000;
  while (Date.now() < injectDeadline) {
    const injectResponse = await fetch(`http://${LOOPBACK_HOST}:${uiPort}/api/inject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-traemeta-enhancer-token": token,
      },
      body: "{}",
    });
    lastInjectStatus = injectResponse.status;
    if (injectResponse.ok) break;
    await delay(500);
  }
  if (lastInjectStatus !== 200) {
    throw new Error(`Failed to inject the enhancer UI: HTTP ${lastInjectStatus}`);
  }

  if (focusPromise) await settleWindowFocus(await focusPromise, exePath, dataDir, token);

  log.info(`[${APP_NAME}] Ready: http://${LOOPBACK_HOST}:${uiPort}`);
  log.info(`[${APP_NAME}] CDP: http://${LOOPBACK_HOST}:${cdpPort}`);
  log.info(`[${APP_NAME}] Accounts: ${health.accountCount || 0}`);
}

async function getToken(dataDirPath) {
  const token = await readTextFile(path.join(dataDirPath, "api-token"));
  return token.trim();
}

main().catch((error) => {
  // The failure that ends a click is exactly the one nobody can see: no console,
  // no panel, nothing. `log.error` mirrors to stderr and appends the message (or
  // the stack, when there is one) to logs/launcher.log.
  log.error(`[${APP_NAME}] launch failed:`, error instanceof Error ? error : String(error));
  process.exitCode = 1;
});
