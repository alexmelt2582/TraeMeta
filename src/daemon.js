import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CdpClient } from "./cdp/client.js";
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_CDP_PORT,
  DEFAULT_DATA_DIR,
  DEFAULT_STORAGE_PATH,
  DEFAULT_TRAE_EXE,
  DEFAULT_UI_PORT,
  GITHUB_REPO,
  LOOPBACK_HOST,
  parsePort,
} from "./constants.js";
import { AccountStore } from "./lib/accounts.js";
import {
  CHECKIN_INTERVALS,
  CREDIT_REMINDER_DAYS,
  configPath,
  loadAppConfig,
  normalizeAppUpdate,
  normalizeCheckin,
  normalizeProxy,
  normalizeTraeUpdate,
  saveAppConfig,
} from "./lib/app-config.js";
import {
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  fetchLatestRelease,
  isNewerVersion,
} from "./lib/app-update.js";
import {
  cleanupInstallerDirectory,
  launchInstaller,
  prepareInstaller,
} from "./lib/app-installer.js";
import { UI_INJECT_PATH } from "./lib/app-paths.js";
import { createDaemonLogger } from "./lib/daemon-log.js";
import { detectSeaApi, loadInjectSource, renderInjectScript } from "./lib/inject-source.js";
import { readJsonFile, readTextFile, writeTextAtomic } from "./lib/json-file.js";
import { serviceSpec } from "./lib/launch-spec.js";
import {
  STATIC_HOSTS,
  describeProxyTestVerdict,
  probeHosts,
  stripProxyEnv,
} from "./lib/net-diagnostics.js";
import {
  applyProxyConfig,
  buildCandidateDispatcher,
  describeActive,
} from "./lib/proxy-runtime.js";
import { DAEMON_LOG_PATH } from "./lib/runtime-paths.js";
import { enableSystemCACertificates, formatCAStatus } from "./lib/system-ca.js";
import {
  TRAE_UPDATE_MODE_SUPPRESSED,
  applyTraeUpdateSetting,
  readTraeUpdateState,
} from "./lib/trae-settings.js";
import {
  createAccountsExport,
  openAccountsExport,
} from "./lib/secure-transfer.js";
import { normalizeAuthSnapshotForInjection } from "./lib/trae-storage.js";
import { SOURCES, createWindowsProbe, resolveTraeExe } from "./lib/trae-locate.js";
import {
  claimCheckin,
  fetchCheckinStatus,
  resolveCheckinReward,
} from "./lib/trae-checkin.js";
import { fetchTraeAccountInsights } from "./lib/trae-insights.js";
import {
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_KEEPALIVE_RETRY_INTERVAL_MS,
  isKeepaliveDue,
  parseDuration,
} from "./lib/trae-keepalive.js";
import {
  readAuthFromSnapshot,
  refreshAccountKeepalive,
  refreshAccountInsights,
  refreshAuthSnapshot,
  refreshAuthSnapshotIfNeeded,
} from "./lib/trae-refresh.js";
import {
  probeCockpitTools,
  startTraeWithCdp,
  stopTraeImmediately,
  traeExecutableExists,
  waitForCdp,
} from "./lib/trae-process.js";
import { TraeOAuthManager } from "./lib/trae-oauth.js";
import {
  applyAuthSnapshot,
  purgeLegacyTransactionDirectory,
  rollbackAuthSnapshot,
  waitForStorageIdentity,
} from "./lib/storage-transaction.js";
import { attachWebSocketJson } from "./lib/ws.js";

const CDP_PORT = parsePort(process.env.TRAEMETA_ENHANCER_CDP_PORT, DEFAULT_CDP_PORT);
const UI_PORT = parsePort(process.env.TRAEMETA_ENHANCER_UI_PORT, DEFAULT_UI_PORT);
const DATA_DIR = process.env.TRAEMETA_ENHANCER_DATA_DIR || DEFAULT_DATA_DIR;
const STORAGE_PATH = process.env.TRAEMETA_ENHANCER_STORAGE_PATH || DEFAULT_STORAGE_PATH;
/**
 * Resolved at startup from the configuration file and live detection. The
 * daemon must still run when TRAE is absent, because check-in and keep-alive
 * work from stored credentials; only the flows that restart TRAE need a path.
 */
let TRAE_EXE = process.env.TRAEMETA_ENHANCER_TRAE_EXE || DEFAULT_TRAE_EXE;
const API_TOKEN_PATH = path.join(DATA_DIR, "api-token");
const LEGACY_TRANSACTION_DIR = path.join(DATA_DIR, "transactions");
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const AUTO_KEEPALIVE_ENABLED = process.env.TRAEMETA_ENHANCER_AUTO_KEEPALIVE !== "0";
const AUTO_KEEPALIVE_INTERVAL_MS = parseDuration(
  process.env.TRAEMETA_ENHANCER_KEEPALIVE_INTERVAL_MS,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
);
const AUTO_KEEPALIVE_RETRY_INTERVAL_MS = parseDuration(
  process.env.TRAEMETA_ENHANCER_KEEPALIVE_RETRY_INTERVAL_MS,
  DEFAULT_KEEPALIVE_RETRY_INTERVAL_MS,
);
const AUTO_KEEPALIVE_SWEEP_INTERVAL_MS = parseDuration(
  process.env.TRAEMETA_ENHANCER_KEEPALIVE_SWEEP_INTERVAL_MS,
  30 * 60 * 1000,
);

const accountStore = new AccountStore(DATA_DIR);
let cdpConnected = false;
let switchInFlight = null;
let loginStartInFlight = null;
let insightsRefreshInFlight = null;
let checkinInFlight = null;
let keepaliveInFlight = null;
/**
 * The in-app upgrade holds the same single slot as every account operation: it
 * stops this daemon by the end of it, so it must not overlap a check-in, a
 * keep-alive or a switch that would be interrupted half way.
 */
let installInFlight = null;
/**
 * Set once the installer has been started, and held until it is known not to
 * have upgraded anything.
 *
 * The download request goes back to null the moment the panel has its reply,
 * while the wizard it started outlives that reply by design — the reply has to
 * reach the panel before the wizard stops this process. Without this second flag
 * the slot would be open again with a wizard already on screen, and a second
 * click on「立即升级」would start a second download on top of it. That is not
 * hypothetical: it is exactly the "下载又弹出来一次，卡在 6%" report.
 */
let installHandedOff = false;

/** True while an upgrade owns the slot, download and wizard alike. */
function isInstallBusy() {
  return installInFlight !== null || installHandedOff;
}

/**
 * Assigned by `main()` once the HTTP server is listening. Restarting is only
 * meaningful from that point on, and a hook keeps `route()` free of the server's
 * local state.
 */
let daemonShutdown = null;
let daemonRestartRequested = false;

/**
 * Assigned by `main()` next to the timers themselves. `POST /api/settings/checkin`
 * has to reach the running schedule, and a hook keeps `route()` out of the
 * timers' local state.
 */
let rescheduleAutoCheckin = null;

/**
 * Same idea for the update check: `POST /api/settings/app-update` has to reach
 * the running schedule instead of waiting for the next daemon start.
 */
let rescheduleAppUpdate = null;

/**
 * Set at start-up when this run actually changed TRAE's settings file, so the
 * panel can say so once instead of changing a user's editor configuration
 * silently. Cleared when the panel has been told.
 */
let traeUpdateStartupNotice = null;
/** Set when TRAE's settings file could not be read or written at start-up. */
let traeUpdateStartupError = null;

async function getApiToken() {
  const existing = await readTextFile(API_TOKEN_PATH, { required: false });
  if (existing?.trim()) return existing.trim();
  const token = crypto.randomBytes(32).toString("hex");
  await writeTextAtomic(API_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

async function buildInjectScript(apiToken, seaApi) {
  const source = await loadInjectSource({ fallbackPath: UI_INJECT_PATH, seaApi });
  return renderInjectScript(source, {
    apiBase: `http://${LOOPBACK_HOST}:${UI_PORT}`,
    apiToken,
    appVersion: APP_VERSION,
  });
}

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-traemeta-enhancer-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(payload);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireApiToken(request, apiToken) {
  return request.headers["x-traemeta-enhancer-token"] === apiToken;
}

/**
 * Event name the injected panel listens for. Both sides must agree on it.
 */
const ACCOUNTS_UPDATED_EVENT = "traemeta:accounts-updated";

/**
 * Tells the injected panel that a newer release was found, so an already-open
 * About tab can show its dot without waiting to be reopened.
 */
const UPDATE_AVAILABLE_EVENT = "traemeta:update-available";

/**
 * Tells the injected panel how far the in-app upgrade has got.
 *
 * The download runs inside the panel's own request, so without this the panel
 * could only show one frozen line for the two minutes the bytes take to arrive.
 * The payload carries the whole install state, so a panel that was opened halfway
 * through can paint itself from one event instead of needing history.
 */
const UPDATE_PROGRESS_EVENT = "traemeta:update-progress";

/**
 * One-off line the panel shows to the user.
 *
 * Only the launcher uses it, for the one thing it cannot say any other way: it
 * runs without a console, so "the TRAE window could not be brought up" would
 * otherwise be invisible. Nothing is stored — a panel that is not open simply
 * misses it, which is why the panel opens itself when this arrives.
 */
const NOTICE_EVENT = "traemeta:notice";

/**
 * Tells the injected panel that account state changed on disk.
 *
 * The panel is a pure view — it never derives check-in state itself — so this is
 * how a background sweep makes an already-open panel show the new result. The
 * panel keeps no polling loop, so without this push it would only catch up the
 * next time it was opened, which is exactly the v1.0.0 defect.
 *
 * Never throws. A disconnected CDP is recoverable: the panel refreshes whenever
 * it is opened, which is the fallback path on a machine where injection failed.
 */
async function notifyAccountsUpdated(cdpClient) {
  return notifyPanel(cdpClient, ACCOUNTS_UPDATED_EVENT);
}

/**
 * Delivers one event to the injected panel, optionally with a detail payload.
 *
 * Never throws, and a disconnected CDP is not an error worth failing a caller
 * over: the panel also reads the daemon's state whenever it is opened, which is
 * the fallback path on a machine where injection failed.
 */
async function notifyPanel(cdpClient, event, detail) {
  if (!cdpClient?.isConnected) {
    // Worth a line in the log: on another machine this is the evidence that the
    // open panel will stay stale until it is reopened.
    console.warn(`[push] CDP is not connected; "${event}" was not delivered`);
    return false;
  }
  const payload = detail === undefined ? "{}" : JSON.stringify(detail);
  try {
    // Broadcast: TRAE may have several windows open (Code workbenches and the
    // Agent page), each with its own panel.
    const delivered = await cdpClient.broadcast(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}, { detail: ${payload} }))`,
      { awaitPromise: false, timeoutMs: 3000 },
    );
    if (!delivered) console.warn(`[push] "${event}" was not delivered to any window`);
    return delivered;
  } catch (error) {
    console.warn(`[push] failed to deliver "${event}": ${error?.message || error}`);
    return false;
  }
}

/**
 * Automatic check-in as the panel renders it.
 *
 * `options` and `reminderOptions` are published from here rather than hard-coded
 * in the panel, so the allowed values cannot drift between the two.
 */
function checkinSettingsPayload(checkin) {
  return {
    auto: checkin.auto,
    intervalMinutes: checkin.intervalMinutes,
    onClientLoad: checkin.onClientLoad,
    reminderDays: checkin.reminderDays,
    options: [...CHECKIN_INTERVALS],
    reminderOptions: [...CREDIT_REMINDER_DAYS],
  };
}

/* -------------------------------------------------------------------------- *
 * TRAE's own auto-update
 *
 * `update.mode: "manual"` is what stops TRAE from checking for updates, and it is
 * read once, when TRAE starts, so the panel always says "restart TRAE to take
 * effect" instead of implying the change is already live.
 * -------------------------------------------------------------------------- */

/** The shape the panel renders for the TRAE update section. */
function traeUpdatePayload(state, extra = {}) {
  return {
    suppress: extra.suppress ?? null,
    path: state.path,
    settingsExists: state.exists,
    fileMode: state.mode,
    settingsSuppressed: state.suppressed,
    readable: state.readable,
    error: state.error ?? null,
    backupPath: extra.backupPath ?? null,
    changed: extra.changed ?? false,
    // TRAE reads this setting when it starts, so an edit is never live yet.
    traeRestartRequired: true,
  };
}

/**
 * Makes TRAE's settings file match the saved preference.
 *
 * `previousMode` is captured before the first write so "允许自动更新" can restore
 * what was there rather than guessing. The write is skipped when the file already
 * says the right thing, which keeps TRAE's settings.json untouched on every daemon
 * restart.
 */
async function syncTraeUpdateSetting({ suppress, previousMode = null } = {}) {
  const current = await readTraeUpdateState();
  const remembered =
    previousMode ??
    (typeof current.mode === "string" && current.mode !== TRAE_UPDATE_MODE_SUPPRESSED
      ? current.mode
      : null);
  const result = await applyTraeUpdateSetting({ suppress, previousMode: remembered });
  return { result, state: await readTraeUpdateState(), remembered };
}

/* -------------------------------------------------------------------------- *
 * This helper's own updates
 *
 * The panel cannot do this itself: TRAE's workbench enforces a CSP that blocks
 * HTTP from the injected page, so the check runs here. The result is cached for
 * the panel to read and pushed when a new release appears.
 * -------------------------------------------------------------------------- */

/**
 * Last completed check.
 *
 * `checkedAt` is stamped on failures too. A transient network error then cannot
 * turn the 24-hour schedule into a retry loop against GitHub, and the panel's
 * own「检查更新」button is what forces a fresh attempt.
 */
let appUpdateState = { checkedAt: null, latest: null, error: null };
let appUpdateCheckInFlight = null;
/**
 * What the in-app upgrade is doing right now.
 *
 * Advanced only by `POST /api/update/install`, pushed to the panel as it changes
 * (see `UPDATE_PROGRESS_EVENT`) and read back when the About tab is opened, so a
 * panel that reconnects halfway through still shows where the upgrade is. The
 * push does go silent at the very end — the installer stops this process — which
 * is why the panel also treats a dropped connection as "the installer took over"
 * rather than as a failure.
 */
let installState = idleInstallState();

/** Highest 5% bucket already pushed, so a 23 MB download is not 350 events. */
let installProgressBucket = 0;

function idleInstallState() {
  return { stage: "idle", version: null, error: null, percent: null, received: null, total: null };
}

function publishInstallState(cdpClient, patch) {
  installState = { ...installState, ...patch };
  return notifyPanel(cdpClient, UPDATE_PROGRESS_EVENT, { ...installState });
}

/**
 * Reopens the upgrade slot after a wizard that upgraded nothing.
 *
 * The installer is what stops this daemon, so reaching this with the process
 * still alive means the wizard ended before it replaced a single file: the user
 * closed it, or it could not start at all. Reporting `cancelled` rather than
 * `idle` matters — `idle` is also what a freshly started daemon reports, and the
 * panel deliberately ignores that one so a stale box cannot reappear.
 */
function releaseInstallHandoff(cdpClient) {
  if (!installHandedOff) return;
  installHandedOff = false;
  installProgressBucket = 0;
  publishInstallState(cdpClient, {
    stage: "cancelled",
    error: null,
    percent: null,
    received: null,
    total: null,
  });
}

function appUpdatePayload() {
  const latest = appUpdateState.latest;
  return {
    current: APP_VERSION,
    repo: GITHUB_REPO,
    checkedAt: appUpdateState.checkedAt,
    latest,
    error: appUpdateState.error,
    hasUpdate: !!latest && isNewerVersion(latest.version, APP_VERSION),
    install: { ...installState },
  };
}

function isAppUpdateCheckFresh({ now = Date.now() } = {}) {
  const checkedAt = Date.parse(appUpdateState.checkedAt || "");
  return Number.isFinite(checkedAt) && now - checkedAt < DEFAULT_UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Performs one update check, or reuses a recent result.
 *
 * Concurrent callers share a single request: the panel and the timer can ask at
 * the same moment, and two checks would only race to write the same state.
 */
async function checkForAppUpdate({ force = false } = {}) {
  if (!force && isAppUpdateCheckFresh()) return { ...appUpdatePayload(), cached: true };
  if (appUpdateCheckInFlight) return appUpdateCheckInFlight;

  appUpdateCheckInFlight = (async () => {
    try {
      const latest = await fetchLatestRelease({ repo: GITHUB_REPO });
      appUpdateState = { checkedAt: new Date().toISOString(), latest, error: null };
      console.log(
        `[update] latest=${latest.version} current=${APP_VERSION} hasUpdate=${isNewerVersion(latest.version, APP_VERSION)}`,
      );
      return { ...appUpdatePayload(), cached: false };
    } catch (error) {
      const message = error?.message || String(error);
      // The panel is a product surface, so it never gets the transport's own words:
      // `GET https://api.github.com/repos/<repo>/releases/latest 超时（15000ms）`
      // names an internal address and a socket budget, and neither is something a
      // user can act on. Every failed check reads the same there — it could not
      // reach the network — while the full chain goes to the log, the one place a
      // real cause can be read.
      // The previously found release is kept: a failed re-check is not evidence
      // that the update went away, and dropping it would hide a known one.
      appUpdateState = {
        checkedAt: new Date().toISOString(),
        latest: appUpdateState.latest,
        error: "网络连接失败",
      };
      console.warn(`[update] check failed: ${message}`);
      return { ...appUpdatePayload(), cached: false };
    } finally {
      appUpdateCheckInFlight = null;
    }
  })();
  return appUpdateCheckInFlight;
}

/**
 * Downloads, verifies and finally runs the installer for a found release.
 *
 * The download is done inside the user's own request, so a failure is reported
 * where the button is, instead of being written to a log the user never opens.
 * The request can stay open for minutes, which is why every change of state is
 * pushed to the panel as it happens instead of being answerable only at the end.
 *
 * The installer stops this daemon on its way in — Windows will not let it replace
 * a running executable — so this process does not survive to see the outcome.
 * That is also why the launch is detached and delayed: the reply has to reach the
 * panel's socket before the installer takes the port down. The installer itself
 * is what brings the service back afterwards.
 */
async function installAppUpdate(release, cdpClient) {
  const installer = release.installer;
  installProgressBucket = 0;
  await publishInstallState(cdpClient, {
    stage: "downloading",
    version: release.version,
    error: null,
    percent: 0,
    received: 0,
    total: installer.size,
  });
  try {
    const { path: installerPath, bytes, reused } = await prepareInstaller(installer, {
      // Verification runs on a file that is already fully on disk, so the bar is
      // full by then whatever the last chunk happened to round to.
      onStage: (stage) =>
        publishInstallState(cdpClient, stage === "verifying" ? { stage, percent: 100 } : { stage }),
      /**
       * Throttled to whole 5% steps: the download reports every chunk, and one
       * CDP evaluation per chunk would spend more time talking to the panel than
       * the panel spends reading it. The final 100% is not this path — the verify
       * stage below states it, and it is the only one that is actually complete.
       */
      onProgress: ({ received, total }) => {
        const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null;
        installState = { ...installState, received, total, percent };
        const bucket = percent === null ? installProgressBucket : Math.floor(percent / 5);
        if (bucket <= installProgressBucket) return undefined;
        installProgressBucket = bucket;
        return notifyPanel(cdpClient, UPDATE_PROGRESS_EVENT, { ...installState });
      },
    });
    console.log(
      `[update] ${reused ? "reused the already verified" : "verified"} ${installer.name}` +
        ` (${bytes} bytes, sha256 ${installer.digest.slice(0, 12)}…), starting the installer`,
    );
    await publishInstallState(cdpClient, {
      stage: "installing",
      percent: 100,
      received: installer.size,
      total: installer.size,
    });

    /**
     * The slot stays shut from here on.
     *
     * From the moment a wizard is due to appear, a second「立即升级」has to be
     * refused instead of starting a parallel download of the very file that
     * wizard is running from — Windows answers a write to a running executable
     * with an error or with nothing at all, which is the download that appeared
     * to hang once already.
     */
    installHandedOff = true;
    const timer = setTimeout(() => {
      try {
        const child = launchInstaller(installerPath);
        console.log(`[update] installer started pid=${child.pid ?? "unknown"}`);
        child.once("error", (error) => {
          console.error(`[update] the installer could not start: ${error?.message || error}`);
          releaseInstallHandoff(cdpClient);
        });
        // Only reachable while this process is alive, and Inno stops the service
        // before it replaces a single file: a wizard that exited here upgraded
        // nothing, so the button has to become usable again.
        child.once("exit", () => releaseInstallHandoff(cdpClient));
      } catch (error) {
        console.error(`[update] starting the installer failed: ${error?.message || error}`);
        releaseInstallHandoff(cdpClient);
      }
    }, 800);
    timer.unref?.();

    return { stage: "installing", version: release.version, installer: installer.name };
  } catch (error) {
    const message = error?.message || String(error);
    /**
     * Two readers, two sentences. The log gets the full technical message — the
     * only place the real cause survives, since the daemon dies in the middle of
     * every successful install and the panel box can be closed — while the panel
     * gets the short one a person can act on. `userMessage` is set by the module
     * that knows which failures are worth translating; falling back to `message`
     * keeps an untranslated failure visible rather than blank.
     */
    const reported = error?.userMessage || message;
    console.error(`[update] install failed: ${message}`);
    await publishInstallState(cdpClient, {
      stage: "failed",
      error: reported,
      percent: null,
      received: null,
      total: null,
    });
    throw error;
  }
}

/**
 * Restarts the daemon by handing the job to a detached helper and then exiting.
 *
 * The helper is `service daemon --wait-pid <this pid>`, so it waits for this
 * process to disappear before spawning a replacement and the two never contend
 * for the listening port. The child environment is stripped of inherited proxy
 * controls so the release build always uses a direct connection.
 *
 * The helper also re-creates the supervisor if it is missing, so a restart repairs
 * a machine where the logon autostart entry is absent.
 */
function scheduleDaemonRestart() {
  if (!daemonShutdown) {
    throw new Error("守护进程仍在启动中，请稍后再试");
  }
  if (daemonRestartRequested) {
    return { restarting: true, alreadyRequested: true, pid: process.pid, helperPid: null };
  }
  daemonRestartRequested = true;

  const launch = serviceSpec("daemon", ["--wait-pid", String(process.pid)]);
  let helperPid = null;
  try {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: stripProxyEnv(process.env),
    });
    child.unref();
    helperPid = child.pid ?? null;
  } catch (error) {
    daemonRestartRequested = false;
    throw new Error(`无法启动重启助手：${error?.message || error}`);
  }

  console.log(`[restart] helper pid=${helperPid ?? "unknown"} is waiting for pid ${process.pid}`);

  // Give the HTTP response a moment to flush before this process goes away; the
  // shutdown path closes live connections, which would cut off that response.
  const timer = setTimeout(() => {
    daemonShutdown()?.catch?.((error) => {
      console.error(`[restart] shutdown failed: ${error?.message || error}`);
      process.exit(0);
    });
  }, 400);
  timer.unref?.();

  return { restarting: true, alreadyRequested: false, pid: process.pid, helperPid };
}

/**
 * Stops TRAE on an account switch.
 *
 * A switch force-closes the TRAE the user is looking at, so it kills outright
 * instead of asking the window to close: closing it only parks the app in the
 * notification area, which means the graceful path never quits and the kill runs
 * late anyway — the waiting was the only thing it ever added. One PowerShell call
 * does find → kill → verify, which is what keeps the switch feeling instant.
 */
async function stopTraeForSwitch() {
  if (!(await traeExecutableExists(TRAE_EXE))) {
    throw new Error(
      [
        `Trae CN 的可执行文件不存在：${TRAE_EXE}`,
        "请先指定一次路径，之后会被记住：",
        '  TraeMeta.exe configure --trae-exe "D:\\路径\\Trae CN.exe"',
      ].join("\n"),
    );
  }
  const remaining = await stopTraeImmediately(TRAE_EXE);
  if (remaining.length) {
    throw new Error("Trae CN did not remain fully stopped");
  }
}

async function startTraeForSwitch() {
  await startTraeWithCdp(TRAE_EXE, CDP_PORT);
  return await waitForCdp(CDP_PORT);
}

async function restartTraeForSwitch() {
  await stopTraeForSwitch();
  return await startTraeForSwitch();
}

async function switchAccount(accountId) {
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const account = await accountStore.findAccount(accountId);
  if (!account) throw new Error("Account backup was not found");
  const label = account.displayName || account.email || account.userId || accountId;
  console.log(`[switch] 开始切换账号「${label}」`);
  let snapshot = normalizeAuthSnapshotForInjection(
    await accountStore.readSnapshot(accountId),
  );

  try {
    const refreshed = await refreshAuthSnapshotIfNeeded(snapshot);
    snapshot = refreshed.snapshot;
    if (refreshed.refreshedToken) await accountStore.saveSnapshot(accountId, snapshot);
  } catch (error) {
    throw new Error(
      `目标账号登录凭据已失效，请重新登录该账号后再切换：${error.message || error}`,
    );
  }

  console.log(`[switch] 凭据就绪，正在停止 TRAE（已用时 ${elapsed()}）`);
  await stopTraeForSwitch();
  console.log(`[switch] TRAE 已停止，正在写入账号状态（已用时 ${elapsed()}）`);
  let transaction;
  try {
    transaction = await applyAuthSnapshot({
      storagePath: STORAGE_PATH,
      snapshot,
    });
  } catch (error) {
    await startTraeForSwitch().catch(() => false);
    throw error;
  }

  try {
    await startTraeForSwitch();
    console.log(`[switch] TRAE 已重启，正在校验登录状态（已用时 ${elapsed()}）`);
    const verification = await waitForStorageIdentity(STORAGE_PATH, account.userId);
    if (!verification.ok) {
      throw new Error("TRAE did not accept the selected account after restart");
    }
    console.log(`[switch] 切换完成「${label}」（总用时 ${elapsed()}）`);
    return {
      account,
      transactionId: transaction.transactionId,
      verified: true,
      refreshWarning: null,
    };
  } catch (error) {
    console.log(`[switch] 切换失败，正在回滚到原账号：${error.message || error}`);
    await stopTraeForSwitch().catch(() => {});
    await rollbackAuthSnapshot(STORAGE_PATH, transaction);
    await restartTraeForSwitch().catch(() => false);
    throw new Error(`${error.message}; the previous login state was restored`);
  }
}

async function refreshAccountsInsights(accountIds = null) {
  const accounts = await accountStore.list();
  const requested = accountIds ? new Set(accountIds.map(String)) : null;
  const selected = requested
    ? accounts.filter((account) => requested.has(account.id))
    : accounts;
  if (requested && selected.length !== requested.size) {
    throw new Error("One or more selected account backups were not found");
  }
  if (!selected.length) throw new Error("没有可刷新的账号");

  const results = [];
  for (const account of selected) {
    try {
      const snapshot = await accountStore.readSnapshot(account.id);
      const refreshed = await refreshAccountInsights(snapshot);
      if (refreshed.refreshedToken) {
        await accountStore.saveSnapshot(account.id, refreshed.snapshot);
      }
      const saved = await accountStore.saveInsights(account.id, refreshed.insights);
      results.push({ id: account.id, ok: true, account: saved });
    } catch (error) {
      const message = error.message || String(error);
      const saved = await accountStore.saveInsights(account.id, {
        ...(account.insights || {}),
        error: message,
        updatedAt: new Date().toISOString(),
      });
      results.push({ id: account.id, ok: false, error: message, account: saved });
    }
  }

  return {
    total: results.length,
    updated: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

function checkinDateKey(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

/**
 * Checks and, when needed, claims today's reward for one account.
 *
 * `allowTokenRefresh` gates the only step that rotates credentials. Cockpit Tools
 * rotates the same refresh tokens, so when its presence cannot be determined the
 * check-in still runs with the existing credentials but must not rotate them.
 */
/**
 * Resolves how a sweep must react to the current Cockpit Tools state.
 *
 * The three outcomes are intentionally different. Cockpit Tools and this daemon
 * rotate the same refresh tokens, so the real conflict surface is *rotation*:
 *
 *   - `skip`            — Cockpit is definitely running; do nothing at all.
 *   - `no-token-refresh` — the probe could not decide. A check-in only reuses the
 *                          existing credentials, so it may proceed; keep-alive
 *                          always rotates, so it must not.
 *   - `run`             — Cockpit is definitely not running.
 *
 * `probeCockpitTools()` never throws, so a broken probe can no longer abort a
 * whole sweep the way the PowerShell-only probe did in v1.0.0.
 */
async function resolveCockpitPolicy() {
  const probe = await probeCockpitTools();
  if (probe.running === true) return { action: "skip", probe };
  if (probe.running === null) {
    console.warn(
      `[cockpit] probe failed (${probe.error}); check-in continues without token rotation, keep-alive will skip`,
    );
    return { action: "no-token-refresh", probe };
  }
  return { action: "run", probe };
}

/**
 * Reads which saved account TRAE is signed in as right now.
 *
 * The three outcomes are not interchangeable. `unknown` means the identity could
 * not be read at all, and any path that rotates credentials has to treat it as
 * unsafe rather than as "nobody is signed in".
 */
async function resolveActiveAccountState() {
  try {
    const storageRoot = await readJsonFile(STORAGE_PATH);
    return await accountStore.resolveActiveAccount(storageRoot);
  } catch {
    return { id: null, state: "unknown" };
  }
}

async function checkinOneAccount(
  account,
  { force = false, reason = "manual", allowTokenRefresh = true } = {},
) {
  const date = checkinDateKey();
  if (!force && account.checkin?.date === date && account.checkin.checkedInToday) {
    return { id: account.id, ok: true, skipped: true, reason: "already_checked" };
  }

  let snapshot = await accountStore.readSnapshot(account.id);
  let refreshedToken = false;
  const deviceId = account.userId || account.id;
  const runFlow = async () => {
    const status = await fetchCheckinStatus(snapshot, { deviceId });
    if (status.checkedInToday) return { status, claimed: false };
    try {
      const claim = await claimCheckin(snapshot, { deviceId });
      let finalStatus = claim;
      try {
        finalStatus = await fetchCheckinStatus(snapshot, { deviceId });
      } catch {
        // Claim success is still authoritative if the follow-up status refresh fails.
      }
      return { status: finalStatus, claim, claimed: true };
    } catch (error) {
      try {
        const recoveredStatus = await fetchCheckinStatus(snapshot, { deviceId });
        if (recoveredStatus.checkedInToday) {
          return { status: recoveredStatus, claimed: false };
        }
      } catch {
        // Preserve the claim error when the follow-up status check also fails.
      }
      throw error;
    }
  };

  try {
    let result;
    try {
      result = await runFlow();
    } catch (error) {
      if (!error.authExpired) throw error;
      if (!allowTokenRefresh) throw error;
      const refreshed = await refreshAuthSnapshot(snapshot);
      snapshot = refreshed.snapshot;
      refreshedToken = true;
      await accountStore.saveSnapshot(account.id, snapshot);
      result = await runFlow();
    }

    const reward = resolveCheckinReward(result.status, result.claim);
    const saved = await accountStore.saveCheckin(account.id, {
      date,
      checkedInToday: true,
      checkedAt: new Date().toISOString(),
      credits: result.status.credits,
      reward,
      error: null,
      reason,
      updatedAt: new Date().toISOString(),
    });
    return {
      id: account.id,
      ok: true,
      skipped: !result.claimed,
      reward,
      credits: result.status.credits,
      refreshedToken,
      account: saved,
    };
  } catch (error) {
    const message = error.message || String(error);
    const saved = await accountStore.saveCheckin(account.id, {
      ...(account.checkin || {}),
      date,
      checkedInToday: false,
      error: message,
      reason,
      updatedAt: new Date().toISOString(),
    });
    return { id: account.id, ok: false, error: message, account: saved };
  }
}

async function runAccountCheckin(
  accountIds = null,
  { force = false, reason = "manual", allowTokenRefresh = true } = {},
) {
  if (checkinInFlight) throw new Error("Account check-in is already running");
  checkinInFlight = (async () => {
    const accounts = await accountStore.list();
    const requested = accountIds ? new Set(accountIds.map(String)) : null;
    const selected = requested
      ? accounts.filter((account) => requested.has(account.id))
      : accounts;
    if (requested && selected.length !== requested.size) {
      throw new Error("One or more selected account backups were not found");
    }
    if (!selected.length) throw new Error("没有可签到的账号");

    const results = [];
    for (const account of selected) {
      results.push(await checkinOneAccount(account, { force, reason, allowTokenRefresh }));
      if (selected.length > 1) await delay(350);
    }
    return {
      total: results.length,
      checkedIn: results.filter((result) => result.ok && !result.skipped).length,
      skipped: results.filter((result) => result.ok && result.skipped).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  })();
  try {
    return await checkinInFlight;
  } finally {
    checkinInFlight = null;
  }
}

async function keepaliveOneAccount(account, { reason = "scheduled" } = {}) {
  try {
    const snapshot = await accountStore.readSnapshot(account.id);
    const refreshed = await refreshAccountKeepalive(snapshot);
    await accountStore.saveSnapshot(account.id, refreshed.snapshot);
    if (refreshed.insights) {
      await accountStore.saveInsights(account.id, refreshed.insights);
    }
    const warning = refreshed.insightsError || refreshed.insights?.error || null;
    const auth = refreshed.auth || {};
    const saved = await accountStore.saveKeepalive(account.id, {
      status: "ok",
      reason,
      tokenRefreshed: refreshed.refreshedToken,
      accessExpiresAt: auth.expiredAt || null,
      refreshExpiresAt: auth.refreshExpiredAt || null,
      insightsUpdated: !!refreshed.insights,
      warning,
      error: null,
      updatedAt: new Date().toISOString(),
    });
    return {
      id: account.id,
      ok: true,
      skipped: false,
      refreshedToken: refreshed.refreshedToken,
      insightsUpdated: !!refreshed.insights,
      warning,
      account: saved,
    };
  } catch (error) {
    const message = error.message || String(error);
    const saved = await accountStore.saveKeepalive(account.id, {
      ...(account.keepalive || {}),
      status: "error",
      reason,
      tokenRefreshed: false,
      insightsUpdated: false,
      warning: null,
      error: message,
      updatedAt: new Date().toISOString(),
    });
    return { id: account.id, ok: false, error: message, account: saved };
  }
}

/**
 * Exchanges one account's credentials ahead of their expiry.
 *
 * This is the manual counterpart of the keep-alive sweep and the only path that
 * rotates on request rather than on expiry. The exchange mints new tokens and
 * retires the refresh token every other device holds, so it only ever runs from
 * an explicit user action.
 *
 * The exchange reports a new expiry only when the server sends one. When it does
 * not, the stored date is unchanged, and the caller must say so rather than claim
 * a renewal: a date that did not move is not evidence that anything was extended.
 */
async function renewOneAccount(account) {
  const snapshot = await accountStore.readSnapshot(account.id);
  const before = readAuthFromSnapshot(snapshot) || {};
  const refreshed = await refreshAuthSnapshot(snapshot);
  const saved = await accountStore.saveSnapshot(account.id, refreshed.snapshot);
  const auth = refreshed.auth || {};
  const previousExpiresAt = before.expiredAt || null;
  const accessExpiresAt = auth.expiredAt || null;
  const renewed = !!accessExpiresAt && accessExpiresAt !== previousExpiresAt;
  const savedKeepalive = await accountStore.saveKeepalive(account.id, {
    status: "ok",
    reason: "renew",
    tokenRefreshed: true,
    accessExpiresAt,
    refreshExpiresAt: auth.refreshExpiredAt || null,
    insightsUpdated: false,
    warning: null,
    error: null,
    updatedAt: new Date().toISOString(),
  });
  return {
    id: account.id,
    ok: true,
    renewed,
    previousExpiresAt,
    accessExpiresAt,
    refreshExpiresAt: auth.refreshExpiredAt || null,
    account: savedKeepalive || saved,
  };
}

async function keepaliveActiveAccount(
  account,
  storageRoot,
  { reason = "scheduled" } = {},
) {
  try {
    await accountStore.backupCurrent(storageRoot, { now: Date.now() });
    const snapshot = await accountStore.readSnapshot(account.id);
    let insights = null;
    let warning = null;
    try {
      insights = await fetchTraeAccountInsights(snapshot);
    } catch (error) {
      warning = error.message || String(error);
    }
    if (insights) await accountStore.saveInsights(account.id, insights);
    // Display-only metadata: never let it turn a healthy sweep into an error.
    let auth = {};
    try {
      auth = readAuthFromSnapshot(snapshot) || {};
    } catch {
      auth = {};
    }
    const saved = await accountStore.saveKeepalive(account.id, {
      status: "ok",
      reason,
      tokenRefreshed: false,
      syncedFromLive: true,
      accessExpiresAt: auth.expiredAt || null,
      refreshExpiresAt: auth.refreshExpiredAt || null,
      insightsUpdated: !!insights,
      warning,
      error: null,
      updatedAt: new Date().toISOString(),
    });
    return {
      id: account.id,
      ok: true,
      skipped: false,
      activeAccount: true,
      tokenRefreshed: false,
      syncedFromLive: true,
      insightsUpdated: !!insights,
      warning,
      account: saved,
    };
  } catch (error) {
    const message = error.message || String(error);
    const saved = await accountStore.saveKeepalive(account.id, {
      ...(account.keepalive || {}),
      status: "error",
      reason,
      tokenRefreshed: false,
      syncedFromLive: false,
      insightsUpdated: false,
      warning: null,
      error: message,
      updatedAt: new Date().toISOString(),
    });
    return { id: account.id, ok: false, activeAccount: true, error: message, account: saved };
  }
}

async function runAccountKeepalive(
  accountIds = null,
  { force = false, reason = "manual" } = {},
) {
  if (keepaliveInFlight) throw new Error("Account keepalive is already running");
  keepaliveInFlight = (async () => {
    const accounts = await accountStore.list();
    const requested = accountIds ? new Set(accountIds.map(String)) : null;
    const selected = requested
      ? accounts.filter((account) => requested.has(account.id))
      : accounts;
    if (requested && selected.length !== requested.size) {
      throw new Error("One or more selected account backups were not found");
    }
    if (!selected.length) throw new Error("没有可保活的账号");

    let active = { id: null, state: "unknown" };
    let storageRoot = null;
    try {
      storageRoot = await readJsonFile(STORAGE_PATH);
      active = await accountStore.resolveActiveAccount(storageRoot);
    } catch {
      active = { id: null, state: "unknown" };
    }

    // Rotating a refresh token can invalidate whoever still holds the old one, so
    // it is only safe once TRAE is known not to be signed in as an account we
    // manage. When the live identity cannot be read at all, refusing the whole
    // sweep is the only safe answer — the same rule the Cockpit probe follows.
    // `not-managed` needs no guard: TRAE holds an account outside this list, so
    // refreshing anything here cannot disturb that session.
    if (active.state === "unknown") {
      console.warn(
        "[keepalive] TRAE's signed-in account could not be read; skipping this sweep rather than rotating a refresh token that may still be in use",
      );
      return {
        total: selected.length,
        refreshed: 0,
        skipped: selected.length,
        failed: 0,
        skippedReason: "active-unknown",
        results: selected.map((account) => ({
          id: account.id,
          ok: true,
          skipped: true,
          reason: "active-unknown",
        })),
      };
    }

    const now = Date.now();
    const results = [];
    for (const account of selected) {
      if (
        !force &&
        !isKeepaliveDue(account, {
          now,
          intervalMs: AUTO_KEEPALIVE_INTERVAL_MS,
          retryIntervalMs: AUTO_KEEPALIVE_RETRY_INTERVAL_MS,
        })
      ) {
        results.push({ id: account.id, ok: true, skipped: true, reason: "not_due" });
        continue;
      }
      if (account.id === active.id) {
        results.push(
          await keepaliveActiveAccount(account, storageRoot, { reason }),
        );
        continue;
      }
      results.push(await keepaliveOneAccount(account, { reason }));
      if (selected.length > 1) await delay(500);
    }

    return {
      total: selected.length,
      refreshed: results.filter((result) => result.ok && !result.skipped).length,
      skipped: results.filter((result) => result.ok && result.skipped).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  })();
  try {
    return await keepaliveInFlight;
  } finally {
    keepaliveInFlight = null;
  }
}

async function route(request, response, apiToken, cdpClient, oauthManager) {
  const requestUrl = new URL(request.url || "/", `http://${LOOPBACK_HOST}:${UI_PORT}`);
  const pathname = requestUrl.pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,x-traemeta-enhancer-token",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-max-age": "600",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    const accounts = await accountStore.list();
    jsonResponse(response, 200, {
      ok: true,
      name: APP_NAME,
      version: APP_VERSION,
      pid: process.pid,
      cdpPort: CDP_PORT,
      cdpConnected,
      accountCount: accounts.length,
      keepaliveEnabled: AUTO_KEEPALIVE_ENABLED,
      keepaliveIntervalMs: AUTO_KEEPALIVE_INTERVAL_MS,
    });
    return;
  }

  if (!requireApiToken(request, apiToken)) {
    jsonResponse(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/accounts") {
    const accounts = await accountStore.list();
    let currentAccountId = null;
    let currentAccountState = "unknown";
    try {
      const storageRoot = await readJsonFile(STORAGE_PATH);
      const active = await accountStore.resolveActiveAccount(storageRoot);
      currentAccountId = active.id;
      currentAccountState = active.state;
    } catch {
      currentAccountId = null;
      currentAccountState = "unknown";
    }
    jsonResponse(response, 200, {
      ok: true,
      accounts,
      currentAccountId,
      currentAccountState,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/backup") {
    // Logged here rather than left to the generic handler: the panel's empty state
    // cannot tell "no accounts saved yet" from "adoption failed", so this line is
    // the only place that distinction survives.
    try {
      const storageRoot = await readJsonFile(STORAGE_PATH);
      const liveIdentity = await cdpClient.getLiveIdentity();
      const result = await accountStore.backupCurrent(storageRoot, { liveIdentity });
      await notifyAccountsUpdated(cdpClient);
      jsonResponse(response, 200, { ok: true, ...result });
    } catch (error) {
      console.error(`[backup] could not save the current account: ${error.message || error}`);
      jsonResponse(response, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/export") {
    const body = await readRequestBody(request);
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds.map((value) => String(value || "").trim()).filter(Boolean)
      : null;
    const snapshots = await accountStore.exportSnapshots(accountIds);
    const result = await createAccountsExport(snapshots, String(body.password || ""));
    jsonResponse(response, 200, {
      ok: true,
      filename: result.filename,
      mimeType: result.mimeType,
      content: result.content,
      count: result.count,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/import") {
    const body = await readRequestBody(request);
    const payload = await openAccountsExport(
      String(body.content || ""),
      String(body.password || ""),
    );
    const result = await accountStore.importSnapshots(payload.accounts);
    await notifyAccountsUpdated(cdpClient);
    jsonResponse(response, 200, {
      ok: true,
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
      total: result.total,
      count: result.imported + result.updated,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/delete") {
    if (
      switchInFlight ||
      loginStartInFlight ||
      oauthManager.isActive() ||
      insightsRefreshInFlight ||
      checkinInFlight ||
      keepaliveInFlight ||
      isInstallBusy()
    ) {
      jsonResponse(response, 409, {
        ok: false,
        error: "账号操作正在进行，请稍后再删除",
      });
      return;
    }
    const body = await readRequestBody(request);
    const accountId = String(body.accountId || "").trim();
    const account = await accountStore.findAccount(accountId);
    if (!account) {
      jsonResponse(response, 404, { ok: false, error: "账号备份不存在" });
      return;
    }
    try {
      const storageRoot = await readJsonFile(STORAGE_PATH);
      const active = await accountStore.resolveActiveAccount(storageRoot);
      if (active.state === "matched" && active.id === accountId) {
        jsonResponse(response, 409, {
          ok: false,
          error: "当前正在使用的账号不能删除，请先切换到其他账号",
        });
        return;
      }
    } catch {
      // A live identity we cannot read must not block deleting a local backup.
    }
    const deleted = await accountStore.deleteAccount(accountId);
    if (!deleted) {
      jsonResponse(response, 404, { ok: false, error: "账号备份不存在" });
      return;
    }
    await notifyAccountsUpdated(cdpClient);
    console.log(`[accounts] deleted backup ${accountId}`);
    jsonResponse(response, 200, { ok: true, account: deleted });
    return;
  }

  /**
   * The panel reports that it was just opened.
   *
   * The daemon owns the work so the panel can stay a pure view: reconcile today's
   * check-in state against the server, refresh credits, then push the result back.
   * `checkinOneAccount()` is idempotent, so an account that was already checked in
   * is recorded as such without claiming a second reward — this is what turns
   * "actually checked in but shown as pending" into the correct display without
   * the user pressing anything.
   */
  if (request.method === "POST" && pathname === "/api/accounts/panel-open") {
    if (
      switchInFlight ||
      loginStartInFlight ||
      oauthManager.isActive() ||
      insightsRefreshInFlight ||
      checkinInFlight ||
      keepaliveInFlight ||
      isInstallBusy()
    ) {
      // Another sweep is already producing fresh state and will push when it is
      // done. The panel uses this flag to fall back to its own credit refresh
      // instead of being left with stale numbers.
      jsonResponse(response, 200, { ok: true, busy: true });
      return;
    }

    // Runs before the Cockpit guard on purpose: this touches neither the network
    // nor a credential, so it stays available in exactly the situation that
    // leaves the panel showing a bare「-」 — the sweep being skipped. The panel
    // re-reads the list right after this call, so no push is needed.
    await accountStore
      .fillCredentialExpiryFromSnapshots()
      .then((filled) => {
        if (filled) {
          console.log(`[keepalive] filled the credential expiry of ${filled} account(s)`);
        }
      })
      .catch((error) => {
        console.warn(`[keepalive] filling the credential expiry failed: ${error.message || error}`);
      });

    const cockpit = await resolveCockpitPolicy();
    if (cockpit.action === "skip") {
      jsonResponse(response, 200, {
        ok: true,
        skipped: "cockpit",
        cockpit: { running: true, source: cockpit.probe.source },
      });
      return;
    }

    // When the probe could not decide, the check-in may still run because it only
    // reuses the existing credentials. The credit refresh is skipped instead: it
    // falls back to `refreshAuthSnapshot()` on auth expiry, which does rotate the
    // refresh token that Cockpit Tools also holds.
    const canRotate = cockpit.action === "run";
    let checkin = null;
    let insights = null;
    if (!canRotate) {
      console.warn(
        "[panel-open] Cockpit Tools state is unknown; reconciling check-in without token rotation and skipping the credit refresh",
      );
    }
    try {
      checkin = await runAccountCheckin(null, {
        force: false,
        reason: "panel",
        allowTokenRefresh: canRotate,
      });
    } catch (error) {
      checkin = { error: error.message || String(error) };
    }
    if (canRotate) {
      insightsRefreshInFlight = refreshAccountsInsights(null);
      try {
        insights = await insightsRefreshInFlight;
      } catch (error) {
        insights = { error: error.message || String(error) };
      } finally {
        insightsRefreshInFlight = null;
      }
    }

    await notifyAccountsUpdated(cdpClient);
    jsonResponse(response, 200, {
      ok: true,
      cockpit: { running: cockpit.probe.running, source: cockpit.probe.source },
      checkin,
      insights,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/insights/refresh") {
    if (switchInFlight) {
      jsonResponse(response, 409, { ok: false, error: "An account switch is already running" });
      return;
    }
    if (checkinInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account check-in is already running" });
      return;
    }
    if (keepaliveInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account keepalive is already running" });
      return;
    }
    if (isInstallBusy()) {
      jsonResponse(response, 409, { ok: false, error: "助手更新正在安装，请稍后再试" });
      return;
    }
    if (insightsRefreshInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account insights are already refreshing" });
      return;
    }
    const body = await readRequestBody(request);
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds.map((value) => String(value || "").trim()).filter(Boolean)
      : null;
    insightsRefreshInFlight = refreshAccountsInsights(accountIds);
    try {
      const result = await insightsRefreshInFlight;
      await notifyAccountsUpdated(cdpClient);
      jsonResponse(response, 200, { ok: true, ...result });
    } finally {
      insightsRefreshInFlight = null;
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/checkin/run") {
    if (switchInFlight) {
      jsonResponse(response, 409, { ok: false, error: "An account switch is already running" });
      return;
    }
    if (checkinInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account check-in is already running" });
      return;
    }
    if (keepaliveInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account keepalive is already running" });
      return;
    }
    if (isInstallBusy()) {
      jsonResponse(response, 409, { ok: false, error: "助手更新正在安装，请稍后再试" });
      return;
    }
    if (loginStartInFlight) {
      jsonResponse(response, 409, { ok: false, error: "A login flow is already starting" });
      return;
    }
    if (oauthManager.isActive()) {
      jsonResponse(response, 409, {
        ok: false,
        error: "A seamless login flow is already running",
      });
      return;
    }
    if (insightsRefreshInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account insights are already refreshing" });
      return;
    }
    const body = await readRequestBody(request);
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds.map((value) => String(value || "").trim()).filter(Boolean)
      : null;
    const result = await runAccountCheckin(accountIds, {
      force: body.force === true,
      reason: "manual",
    });
    await notifyAccountsUpdated(cdpClient);
    jsonResponse(response, 200, { ok: true, ...result });
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/keepalive/run") {
    if (switchInFlight) {
      jsonResponse(response, 409, { ok: false, error: "An account switch is already running" });
      return;
    }
    if (checkinInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account check-in is already running" });
      return;
    }
    if (loginStartInFlight) {
      jsonResponse(response, 409, { ok: false, error: "A login flow is already starting" });
      return;
    }
    if (oauthManager.isActive()) {
      jsonResponse(response, 409, {
        ok: false,
        error: "A seamless login flow is already running",
      });
      return;
    }
    if (insightsRefreshInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account insights are already refreshing" });
      return;
    }
    if (keepaliveInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account keepalive is already running" });
      return;
    }
    if (isInstallBusy()) {
      jsonResponse(response, 409, { ok: false, error: "助手更新正在安装，请稍后再试" });
      return;
    }
    const cockpit = await resolveCockpitPolicy();
    if (cockpit.action !== "run") {
      jsonResponse(response, 409, {
        ok: false,
        error:
          cockpit.action === "skip"
            ? "Cockpit Tools is running; keepalive was skipped to avoid token rotation conflicts"
            : "Could not determine whether Cockpit Tools is running; keepalive was skipped because it always rotates credentials",
        cockpit: {
          running: cockpit.probe.running,
          source: cockpit.probe.source,
          error: cockpit.probe.error,
        },
      });
      return;
    }
    const body = await readRequestBody(request);
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds.map((value) => String(value || "").trim()).filter(Boolean)
      : null;
    const result = await runAccountKeepalive(accountIds, {
      force: body.force === true,
      reason: "manual",
    });
    await notifyAccountsUpdated(cdpClient);
    jsonResponse(response, 200, { ok: true, ...result });
    return;
  }

  /**
   * Renews one account's credentials because the user asked for it.
   *
   * Deliberately not `keepalive/run`: that path follows the expiry policy and
   * would skip an account whose credentials still have days left, which is
   * exactly the account the user is looking at when they press this.
   */
  if (request.method === "POST" && pathname === "/api/accounts/renew") {
    if (
      switchInFlight ||
      loginStartInFlight ||
      oauthManager.isActive() ||
      insightsRefreshInFlight ||
      checkinInFlight ||
      keepaliveInFlight ||
      isInstallBusy()
    ) {
      jsonResponse(response, 409, { ok: false, error: "另一个账号操作正在进行，请稍后再试" });
      return;
    }
    const body = await readRequestBody(request);
    const accountId = String(body.accountId || "").trim();
    const account = await accountStore.findAccount(accountId);
    if (!account) {
      jsonResponse(response, 404, { ok: false, error: "账号备份不存在" });
      return;
    }

    // This path always rotates, so both guards the sweep follows apply with no
    // exception: Cockpit Tools rotating the same refresh token would fight it,
    // and a live identity that cannot be read might be one we would break.
    const cockpit = await resolveCockpitPolicy();
    if (cockpit.action !== "run") {
      jsonResponse(response, 409, {
        ok: false,
        error:
          cockpit.action === "skip"
            ? "Cockpit Tools 正在运行，为避免凭据互相失效已跳过续签"
            : "无法确认 Cockpit Tools 是否在运行，续签会轮换凭据，因此已跳过",
        cockpit: {
          running: cockpit.probe.running,
          source: cockpit.probe.source,
          error: cockpit.probe.error,
        },
      });
      return;
    }
    const active = await resolveActiveAccountState();
    if (active.state === "unknown") {
      jsonResponse(response, 409, {
        ok: false,
        error: "无法确认 TRAE 当前登录的账号，续签可能让一个看不见的会话失效，因此已跳过",
      });
      return;
    }
    if (active.state === "matched" && active.id === accountId) {
      jsonResponse(response, 409, {
        ok: false,
        error: "当前正在使用的账号由 TRAE 自己维护，不能在这里续签",
      });
      return;
    }

    try {
      const result = await renewOneAccount(account);
      await notifyAccountsUpdated(cdpClient);
      console.log(`[renew] ${accountId} renewed=${result.renewed}`);
      jsonResponse(response, 200, { ok: true, ...result });
    } catch (error) {
      const message = error.message || String(error);
      console.error(`[renew] ${accountId} failed: ${message}`);
      jsonResponse(response, 500, { ok: false, error: message });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/accounts/switch") {
    if (switchInFlight) {
      jsonResponse(response, 409, { ok: false, error: "An account switch is already running" });
      return;
    }
    if (checkinInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account check-in is already running" });
      return;
    }
    if (keepaliveInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account keepalive is already running" });
      return;
    }
    if (isInstallBusy()) {
      jsonResponse(response, 409, { ok: false, error: "助手更新正在安装，请稍后再试" });
      return;
    }
    if (loginStartInFlight || oauthManager.isActive()) {
      jsonResponse(response, 409, {
        ok: false,
        error: "登录流程正在进行，请先完成或取消再切换账号",
      });
      return;
    }
    const body = await readRequestBody(request);
    switchInFlight = switchAccount(String(body.accountId || ""));
    try {
      const result = await switchInFlight;
      await notifyAccountsUpdated(cdpClient);
      jsonResponse(response, 200, { ok: true, ...result });
    } finally {
      switchInFlight = null;
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/oauth/start") {
    if (checkinInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account check-in is already running" });
      return;
    }
    if (keepaliveInFlight) {
      jsonResponse(response, 409, { ok: false, error: "Account keepalive is already running" });
      return;
    }
    if (isInstallBusy()) {
      jsonResponse(response, 409, { ok: false, error: "助手更新正在安装，请稍后再试" });
      return;
    }
    if (loginStartInFlight) {
      jsonResponse(response, 409, { ok: false, error: "A login flow is already starting" });
      return;
    }
    loginStartInFlight = oauthManager.start();
    try {
      const result = await loginStartInFlight;
      jsonResponse(response, 200, { ok: true, ...result });
    } finally {
      loginStartInFlight = null;
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/oauth/status") {
    const loginId = requestUrl.searchParams.get("loginId") || "";
    const status = oauthManager.status(loginId);
    jsonResponse(response, status.status === "missing" ? 404 : 200, {
      ok: status.status !== "missing",
      ...status,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/oauth/cancel") {
    const body = await readRequestBody(request);
    const cancelled = oauthManager.cancel(String(body.loginId || ""));
    jsonResponse(response, 200, { ok: true, cancelled });
    return;
  }

  if (request.method === "POST" && pathname === "/api/oauth/open") {
    const body = await readRequestBody(request);
    const result = await oauthManager.reopen(String(body.loginId || ""));
    jsonResponse(response, 200, { ok: true, ...(result || { opened: false }) });
    return;
  }

  /**
   * The cached result of the last update check. Reads nothing from the network,
   * so the About tab can call it on every open.
   */
  if (request.method === "GET" && pathname === "/api/update") {
    jsonResponse(response, 200, { ok: true, ...appUpdatePayload() });
    return;
  }

  if (request.method === "POST" && pathname === "/api/update/check") {
    const body = await readRequestBody(request);
    const result = await checkForAppUpdate({ force: body.force === true });
    if (result.hasUpdate) {
      await notifyPanel(cdpClient, UPDATE_AVAILABLE_EVENT, { version: result.latest.version });
    }
    jsonResponse(response, 200, { ok: true, ...result });
    return;
  }

  /**
   * Downloads and installs the release the user asked for.
   *
   * The target comes from this daemon's own cached check, never from the request
   * body: this endpoint downloads a file and then runs it, so it must not become
   * a way to execute an arbitrary address on the user's machine.
   */
  if (request.method === "POST" && pathname === "/api/update/install") {
    const release = appUpdateState.latest;
    if (!release?.installer) {
      jsonResponse(response, 409, {
        ok: false,
        error: release?.installerError || "还没有可安装的新版本，请先检查更新",
      });
      return;
    }
    /**
     * The two 409s are told apart by `code`, not by their text: one means the
     * upgrade is already running and the panel should keep showing its progress,
     * the other means it never started. Reading the message would put the exact
     * wording of both strings on the panel's side of the wire.
     */
    if (isInstallBusy()) {
      jsonResponse(response, 409, {
        ok: false,
        code: "install-in-flight",
        error: "助手更新正在安装，请稍后再试",
      });
      return;
    }
    if (
      switchInFlight ||
      loginStartInFlight ||
      oauthManager.isActive() ||
      insightsRefreshInFlight ||
      checkinInFlight ||
      keepaliveInFlight
    ) {
      jsonResponse(response, 409, {
        ok: false,
        code: "account-busy",
        error: "另一个账号操作正在进行，请稍后再试",
      });
      return;
    }
    installInFlight = installAppUpdate(release, cdpClient);
    try {
      const result = await installInFlight;
      jsonResponse(response, 200, { ok: true, ...result });
    } catch (error) {
      const message = error.message || String(error);
      // The response goes to the same panel that has been reading the progress
      // pushes, so it carries the same short sentence rather than the raw chain.
      const reported = error?.userMessage || message;
      console.error(`[update] installing ${release.version} failed: ${message}`);
      jsonResponse(response, 500, { ok: false, error: reported });
    } finally {
      installInFlight = null;
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/settings") {
    const config = await loadAppConfig(DATA_DIR);
    const updateState = await readTraeUpdateState();
    jsonResponse(response, 200, {
      ok: true,
      checkin: checkinSettingsPayload(config.checkin),
      appUpdate: { ...config.appUpdate },
      traeUpdate: {
        ...traeUpdatePayload(updateState, { suppress: config.traeUpdate.suppress }),
        startupNotice: traeUpdateStartupNotice,
        startupError: traeUpdateStartupError,
      },
      // Never the username or password: `describeActive` reports `hasCredentials`
      // as a boolean so the panel can say "已设置账号" without the secret ever
      // leaving this process.
      network: { state: describeActive(), configPath: configPath(DATA_DIR) },
    });
    return;
  }

  /**
   * Saves the proxy configuration and puts it into effect immediately.
   *
   * Validation runs before anything is written, so a rejected value leaves both
   * the file and the running dispatcher exactly as they were. There is no
   * `restartRequired` in the reply: the dispatcher is swapped in place.
   */
  if (request.method === "POST" && pathname === "/api/settings/network") {
    const body = await readRequestBody(request);
    const current = await loadAppConfig(DATA_DIR);
    let proxy;
    try {
      // The panel never receives the saved username or password, so an omitted
      // credential field means "keep what is stored" — otherwise saving after
      // changing only the port would silently wipe a working login. Clearing is
      // explicit: the panel sends empty strings.
      const submitted = { ...(body?.proxy ?? {}) };
      if (submitted.username === undefined) submitted.username = current.proxy.username;
      if (submitted.password === undefined) submitted.password = current.proxy.password;
      proxy = normalizeProxy(submitted);
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error.message || String(error) });
      return;
    }
    await saveAppConfig(DATA_DIR, { proxy });
    const state = await applyProxyConfig({ proxy });
    console.log(
      `[settings] proxy mode=${state.source} active=${state.active}` +
        `${state.host ? ` ${state.scheme}://${state.host}:${state.port}` : ""}` +
        `${state.reason ? ` reason=${state.reason}` : ""}`,
    );
    jsonResponse(response, 200, {
      ok: true,
      network: { state, configPath: configPath(DATA_DIR) },
    });
    return;
  }

  /**
   * Tests the submitted proxy without saving it: one direct run and one through
   * a candidate dispatcher, so the panel can tell "the proxy is wrong" apart
   * from "the network is down".
   */
  if (request.method === "POST" && pathname === "/api/settings/network/test") {
    const body = await readRequestBody(request);
    let proxy;
    try {
      proxy = normalizeProxy(body?.proxy);
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error.message || String(error) });
      return;
    }
    const hosts =
      Array.isArray(body?.hosts) && body.hosts.length
        ? body.hosts.filter((host) => typeof host === "string" && host.trim()).slice(0, 8)
        : STATIC_HOSTS;

    const direct = await probeHosts(hosts, { timeoutMs: 10000 });
    let proxied = null;
    let candidate = { resolved: { reason: null, notes: [], target: null }, error: null };
    if (proxy.mode !== "off") {
      candidate = await buildCandidateDispatcher(proxy);
      if (candidate.dispatcher) {
        proxied = await probeHosts(hosts, { timeoutMs: 12000, dispatcher: candidate.dispatcher });
      }
    }
    const verdict = describeProxyTestVerdict({ direct, proxied });
    if (candidate.dispatcher && typeof candidate.dispatcher.close === "function") {
      Promise.resolve(candidate.dispatcher.close()).catch(() => {});
    }
    if (candidate.error) {
      console.error(`[settings] proxy test could not build a dispatcher: ${candidate.error}`);
    }
    jsonResponse(response, 200, {
      ok: true,
      hosts,
      direct,
      proxied,
      proxyError: candidate.error,
      proxyReason: candidate.resolved?.reason ?? null,
      proxyNotes: candidate.resolved?.notes ?? [],
      conclusion: verdict.conclusion,
      conclusionText: verdict.text,
      severity: verdict.severity,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/settings/app-update") {
    const body = await readRequestBody(request);
    const current = await loadAppConfig(DATA_DIR);
    const appUpdate = normalizeAppUpdate({
      ...current.appUpdate,
      ...(body?.autoCheck === undefined ? {} : { autoCheck: body.autoCheck }),
    });
    await saveAppConfig(DATA_DIR, { appUpdate });
    // Rebuilt here so the switch takes effect in the running process. No check
    // is triggered as a side effect: saving a setting must not reach the network.
    rescheduleAppUpdate?.({ initialRun: false });
    console.log(`[settings] update checks autoCheck=${appUpdate.autoCheck}`);
    jsonResponse(response, 200, { ok: true, appUpdate });
    return;
  }

  if (request.method === "POST" && pathname === "/api/settings/trae-update") {
    const body = await readRequestBody(request);
    const current = await loadAppConfig(DATA_DIR);
    const suppress =
      body?.suppress === undefined
        ? current.traeUpdate.suppress
        : normalizeTraeUpdate({ suppress: body.suppress }).suppress;

    const { result, state, remembered } = await syncTraeUpdateSetting({
      suppress,
      previousMode: current.traeUpdate.previousMode,
    });
    await saveAppConfig(DATA_DIR, {
      traeUpdate: { suppress, previousMode: suppress ? remembered : current.traeUpdate.previousMode },
    });
    // The user just acted, so a start-up notice would be stale.
    traeUpdateStartupNotice = null;
    traeUpdateStartupError = null;

    console.log(
      `[settings] trae auto-update suppress=${suppress} changed=${result.changed} mode=${state.mode}`,
    );
    jsonResponse(response, 200, {
      ok: true,
      traeUpdate: traeUpdatePayload(state, {
        suppress,
        changed: result.changed,
        backupPath: result.backupPath,
      }),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/settings/checkin") {
    const body = await readRequestBody(request);
    const current = await loadAppConfig(DATA_DIR);
    // Every field is optional and an omitted one keeps its current value: the
    // panel submits the whole card as one form, but a partial request must not
    // quietly reset the rest to the defaults.
    const checkin = normalizeCheckin({
      ...current.checkin,
      ...(body?.auto === undefined ? {} : { auto: body.auto }),
      ...(body?.intervalMinutes === undefined ? {} : { intervalMinutes: body.intervalMinutes }),
      ...(body?.onClientLoad === undefined ? {} : { onClientLoad: body.onClientLoad }),
      ...(body?.reminderDays === undefined ? {} : { reminderDays: body.reminderDays }),
    });
    await saveAppConfig(DATA_DIR, { checkin });
    // This takes effect in the running process: the schedule is rebuilt here,
    // and every later trigger re-reads the configuration. No restart notice.
    rescheduleAutoCheckin?.({ initialRun: false });
    console.log(
      `[settings] checkin auto=${checkin.auto} interval=${checkin.intervalMinutes} onClientLoad=${checkin.onClientLoad} reminderDays=${checkin.reminderDays}`,
    );
    jsonResponse(response, 200, { ok: true, checkin: checkinSettingsPayload(checkin) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/daemon/restart") {
    const result = scheduleDaemonRestart();
    jsonResponse(response, 200, { ok: true, ...result });
    return;
  }

  /**
   * Relays one line from the launcher to the panel as a toast.
   *
   * A push, never state: nothing is written down, so a panel that is not open at
   * that moment loses the message instead of finding it stale the next time it is
   * opened. The launcher is the only caller, and it reports whether the CDP
   * connection was there to deliver it.
   */
  if (request.method === "POST" && pathname === "/api/notice") {
    const body = await readRequestBody(request);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      jsonResponse(response, 400, { ok: false, error: "message is required" });
      return;
    }
    const delivered = await notifyPanel(cdpClient, NOTICE_EVENT, { message });
    jsonResponse(response, 200, { ok: true, delivered });
    return;
  }

  if (request.method === "POST" && pathname === "/api/inject") {
    const injected = await cdpClient.inject();
    jsonResponse(response, injected ? 200 : 503, {
      ok: injected,
      error: injected ? undefined : "CDP is not connected",
    });
    return;
  }

  jsonResponse(response, 404, { ok: false, error: "Not found" });
}

/**
 * Routes every console call through the redacting file logger, so a failure on a
 * user machine leaves evidence without any risk of a credential reaching disk.
 * Returning the logger lets callers flush or inspect the path.
 */
function installLogging() {
  const logger = createDaemonLogger({ logPath: DAEMON_LOG_PATH });
  console.log = (...values) => logger.info(...values);
  console.info = (...values) => logger.info(...values);
  console.warn = (...values) => logger.warn(...values);
  console.error = (...values) => logger.error(...values);

  process.on("uncaughtException", (error) => {
    logger.error(`uncaught exception: ${error?.stack || error}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`unhandled rejection: ${reason?.stack || reason}`);
    process.exit(1);
  });
  return logger;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  installLogging();

  /**
   * Network setup comes before anything that can reach out, and the order
   * matters: the system certificate store is merged first, then the dispatcher
   * is resolved. A failure here is logged with its reason rather than being
   * allowed to look like a working direct connection.
   */
  const caStatus = enableSystemCACertificates();
  console.log(`[net] 系统证书：${formatCAStatus(caStatus)}`);
  const appliedNetwork = await applyProxyConfig(await loadAppConfig(DATA_DIR));
  console.log(
    `[net] 代理 source=${appliedNetwork.source} active=${appliedNetwork.active}` +
      `${appliedNetwork.host ? ` ${appliedNetwork.scheme}://${appliedNetwork.host}:${appliedNetwork.port}` : ""}` +
      `${appliedNetwork.reason ? ` reason=${appliedNetwork.reason}` : ""}`,
  );
  if (appliedNetwork.notes?.length) console.warn(`[net] ${appliedNetwork.notes.join(" ")}`);

  const purgedTransactionDirectory = await purgeLegacyTransactionDirectory(
    LEGACY_TRANSACTION_DIR,
  );
  /**
   * An installed upgrade stops this daemon, so the installer it downloaded is
   * still on disk the next time this process starts — and so is any download that
   * never got that far. Neither is state worth keeping.
   */
  const installersCleared = await cleanupInstallerDirectory();
  const accountRepair = await accountStore.repairIndex();
  const apiToken = await getApiToken();
  const seaApi = await detectSeaApi();

  const traeResolution = await resolveTraeExe({
    dataDir: DATA_DIR,
    probe: createWindowsProbe(),
  });
  if (traeResolution.path) {
    TRAE_EXE = traeResolution.path;
    console.log(
      `[trae] ${TRAE_EXE} (来源: ${SOURCES[traeResolution.source] ?? traeResolution.source})`,
    );
  } else {
    console.warn(
      "[trae] 未找到 Trae CN：账号切换与登录流程不可用；签到与保活不受影响。",
    );
    console.warn(
      '[trae] 请运行 configure --trae-exe "D:\\路径\\Trae CN.exe" 指定一次，之后会记住。',
    );
  }

  /* ------------------------------------------------------------------------ *
   * Automatic check-in
   *
   * The schedule and both on/off switches come from `config.checkin`, and every
   * trigger re-reads the configuration instead of closing over the copy loaded at
   * start-up: `POST /api/settings/checkin` has to take effect in the running
   * process, and a captured value would silently ignore it.
   *
   * All four helpers are function declarations so that `onStateChange` below can
   * reference them before their textual position.
   * ------------------------------------------------------------------------ */

  let autoCheckinTimer = null;
  let autoCheckinStartTimer = null;
  /** Re-armed on every disconnect: one run per TRAE session, not per reconnect. */
  let clientLoadCheckinDone = false;
  /** Set on the first attempt, success or failure: a later reconnect must not
   * adopt an account the user has since removed by hand. */
  let adoptAttempted = false;

  async function runScheduledCheckin(reason) {
    if (
      switchInFlight ||
      loginStartInFlight ||
      oauthManager.isActive() ||
      insightsRefreshInFlight ||
      checkinInFlight ||
      keepaliveInFlight ||
      isInstallBusy()
    ) {
      // Another sweep is already doing the same work; it will push when it is done.
      return;
    }
    try {
      const cockpit = await resolveCockpitPolicy();
      if (cockpit.action === "skip") {
        console.log(`[checkin] ${reason} skipped because Cockpit Tools is running`);
        return;
      }
      const result = await runAccountCheckin(null, {
        force: false,
        reason,
        allowTokenRefresh: cockpit.action !== "no-token-refresh",
      });
      console.log(
        `[checkin] ${reason} checked=${result.checkedIn} skipped=${result.skipped} failed=${result.failed}`,
      );
      await notifyAccountsUpdated(cdpClient);
    } catch (error) {
      console.error(`[checkin] ${reason} run failed: ${error.message || error}`);
    }
  }

  /**
   * Rebuilds the schedule from the saved configuration.
   *
   * `initialRun` is only ever true on the start-up path. A settings change must
   * rebuild the interval without claiming a reward as a side effect, so the
   * caller passes false.
   */
  async function scheduleAutoCheckin({ initialRun = false } = {}) {
    clearTimeout(autoCheckinStartTimer);
    clearInterval(autoCheckinTimer);
    autoCheckinStartTimer = null;
    autoCheckinTimer = null;

    if (process.env.TRAEMETA_ENHANCER_AUTO_CHECKIN === "0") return;

    let config;
    try {
      config = await loadAppConfig(DATA_DIR);
    } catch (error) {
      console.error(`[checkin] could not read the configuration: ${error.message || error}`);
      return;
    }
    if (!config.checkin.auto) {
      console.log("[checkin] automatic check-in is disabled by configuration");
      return;
    }

    if (initialRun) {
      autoCheckinStartTimer = setTimeout(() => void runScheduledCheckin("scheduled"), 5000);
      autoCheckinStartTimer.unref?.();
    }
    autoCheckinTimer = setInterval(
      () => void runScheduledCheckin("scheduled"),
      config.checkin.intervalMinutes * 60 * 1000,
    );
    autoCheckinTimer.unref?.();
  }

  /* ------------------------------------------------------------------------ *
   * Update checks
   *
   * Same shape as the check-in schedule, and for the same reason: the switch in
   * the settings tab has to take effect in the running process, so every trigger
   * re-reads the configuration instead of closing over a start-up copy.
   * ------------------------------------------------------------------------ */

  let appUpdateTimer = null;
  let appUpdateStartTimer = null;

  async function runScheduledAppUpdateCheck(reason) {
    const result = await checkForAppUpdate({ force: false });
    if (result.hasUpdate) {
      await notifyPanel(cdpClient, UPDATE_AVAILABLE_EVENT, { version: result.latest.version });
    }
    console.log(
      `[update] ${reason} check: ${result.error ? `failed (${result.error})` : result.hasUpdate ? `found ${result.latest.version}` : "up to date"}`,
    );
  }

  async function scheduleAppUpdateCheck({ initialRun = false } = {}) {
    clearTimeout(appUpdateStartTimer);
    clearInterval(appUpdateTimer);
    appUpdateStartTimer = null;
    appUpdateTimer = null;

    let config;
    try {
      config = await loadAppConfig(DATA_DIR);
    } catch (error) {
      console.error(`[update] could not read the configuration: ${error.message || error}`);
      return;
    }
    if (!config.appUpdate.autoCheck) {
      console.log("[update] automatic update checks are disabled by configuration");
      return;
    }

    if (initialRun) {
      // Delayed so a daemon restart does not put a network call in front of the
      // work the user is waiting for.
      appUpdateStartTimer = setTimeout(() => void runScheduledAppUpdateCheck("startup"), 20000);
      appUpdateStartTimer.unref?.();
    }
    appUpdateTimer = setInterval(
      () => void runScheduledAppUpdateCheck("scheduled"),
      DEFAULT_UPDATE_CHECK_INTERVAL_MS,
    );
    appUpdateTimer.unref?.();
  }
  rescheduleAppUpdate = scheduleAppUpdateCheck;

  /**
   * Adopts the account that is already signed in, the first time TRAE becomes
   * reachable.
   *
   * The panel opens on a list, never on a live lookup, so this used to happen
   * only inside the panel's own open flow — one attempt, no retry, and a failure
   * that looked exactly like "no accounts saved yet". Doing it here removes the
   * dependence on the moment the panel happened to be opened, and keeps the panel
   * a pure view instead of giving it a retry loop.
   */
  async function adoptCurrentAccount() {
    if (adoptAttempted) return;
    adoptAttempted = true;
    try {
      if ((await accountStore.list()).length) return;
      const storageRoot = await readJsonFile(STORAGE_PATH);
      const active = await accountStore.resolveActiveAccount(storageRoot);
      if (active.state !== "not-managed") {
        // `unknown` means the live identity could not be read at all. TRAE may
        // simply not be signed in yet, which is not a failure worth a stack trace.
        console.log(`[adopt] no account adopted (state=${active.state})`);
        return;
      }
      const liveIdentity = await cdpClient.getLiveIdentity();
      const result = await accountStore.backupCurrent(storageRoot, { liveIdentity });
      console.log(`[adopt] adopted the signed-in account (created=${result.createdSnapshot})`);
      await notifyAccountsUpdated(cdpClient);
    } catch (error) {
      console.error(`[adopt] could not adopt the current account: ${error.message || error}`);
    }
  }

  /** The client-load trigger, the equivalent of one run per page navigation. */
  async function runClientLoadCheckin() {
    try {
      const config = await loadAppConfig(DATA_DIR);
      if (!config.checkin.auto || !config.checkin.onClientLoad) return;
      await runScheduledCheckin("client-load");
    } catch (error) {
      console.error(`[checkin] client-load run failed: ${error.message || error}`);
    }
  }

  const cdpClient = new CdpClient({
    port: CDP_PORT,
    getInjectScript: () => buildInjectScript(apiToken, seaApi),
    onStateChange: (connected) => {
      cdpConnected = connected;
      if (!connected) {
        clientLoadCheckinDone = false;
        return;
      }
      if (clientLoadCheckinDone) return;
      clientLoadCheckinDone = true;
      // This callback is synchronous, and awaiting here would stall the CDP
      // client's own state handling.
      void adoptCurrentAccount();
      void runClientLoadCheckin();
    },
  });

  async function synchronizeSavedAccount(account, { source = "account-saved" } = {}) {
    if (!account?.id) return { ok: false, error: "Account id is missing" };

    const cockpit = await resolveCockpitPolicy();
    if (cockpit.action === "skip") {
      console.log(`[${source}] account sync skipped because Cockpit Tools is running`);
      return { ok: false, skipped: "cockpit" };
    }

    const failures = [];
    try {
      await runAccountCheckin([account.id], {
        reason: source,
        allowTokenRefresh: cockpit.action === "run",
      });
    } catch (error) {
      failures.push(error.message || String(error));
    }

    if (cockpit.action === "run") {
      insightsRefreshInFlight = refreshAccountsInsights([account.id]);
      try {
        await insightsRefreshInFlight;
      } catch (error) {
        failures.push(error.message || String(error));
      } finally {
        insightsRefreshInFlight = null;
      }
    } else {
      console.warn(
        `[${source}] credit refresh skipped because the Cockpit Tools state is unknown`,
      );
    }

    await notifyAccountsUpdated(cdpClient);
    if (failures.length) {
      const message = failures.join(" | ");
      console.error(`[${source}] account sync failed: ${message}`);
      return { ok: false, error: message };
    }
    return { ok: true };
  }

  const oauthManager = new TraeOAuthManager({
    accountStore,
    storagePath: STORAGE_PATH,
    exePath: TRAE_EXE,
    openBrowser: process.env.TRAEMETA_ENHANCER_OPEN_BROWSER !== "0",
    onAccountSaved: (account, metadata) =>
      synchronizeSavedAccount(account, { source: metadata?.source || "oauth" }),
  });
  cdpClient.start();

  const server = http.createServer((request, response) => {
    route(request, response, apiToken, cdpClient, oauthManager).catch((error) => {
      jsonResponse(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  /**
   * 合并版 Trae CN 的 workbench CSP 禁止 `connect-src http:`，但放行 `ws:`，
   * 注入面板因此无法用 fetch 访问本机守护进程。每条 WebSocket JSON 消息在这里
   * 被还原成一个合成 HTTP 请求，复用同一套 `route()`，再把状态码与响应体回传，
   * 面板侧看到的 API 形状与原来的 HTTP 完全一致。
   */
  attachWebSocketJson(server, "/panel", (msg, reply) => {
    const body =
      msg.body === undefined || msg.body === null
        ? undefined
        : typeof msg.body === "string"
          ? msg.body
          : JSON.stringify(msg.body);
    const request = {
      method: String(msg.method || "POST").toUpperCase(),
      url: String(msg.path || "/"),
      headers:
        msg && msg.token ? { "x-traemeta-enhancer-token": String(msg.token) } : {},
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield Buffer.from(body, "utf8");
      },
    };
    let responded = false;
    const response = {
      writeHead(status) {
        this.status = status;
      },
      end(payload) {
        if (responded) return;
        responded = true;
        const text =
          typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
        let data = text;
        try {
          data = JSON.parse(text);
        } catch {
          // 非 JSON 响应体保持原文，交给面板侧自行判断。
        }
        reply({
          id: msg.id,
          ok: this.status >= 200 && this.status < 300,
          status: this.status,
          data,
          error: this.status >= 400 ? text : undefined,
        });
      },
    };
    route(request, response, apiToken, cdpClient, oauthManager).catch(
      (error) => {
        if (responded) return;
        responded = true;
        reply({
          id: msg.id,
          ok: false,
          status: 500,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(UI_PORT, LOOPBACK_HOST, resolve);
  });

  console.log(`${APP_NAME} daemon listening on http://${LOOPBACK_HOST}:${UI_PORT}`);
  console.log(`[cleanup] removed legacy transactions: ${purgedTransactionDirectory}`);
  console.log(
    `[cleanup] update downloads: ${installersCleared ? "cleared" : "kept (the installer is still running)"}`,
  );
  if (accountRepair.repaired) {
    console.log(`[cleanup] repaired account metadata: ${accountRepair.repaired}`);
  }

  // TRAE's auto-update is switched off here rather than lazily, so the panel can
  // report the real result the moment it opens. A silent failure would look exactly
  // like a setting that was applied.
  try {
    const config = await loadAppConfig(DATA_DIR);
    const { result, state } = await syncTraeUpdateSetting({
      suppress: config.traeUpdate.suppress,
      previousMode: config.traeUpdate.previousMode,
    });
    traeUpdateStartupNotice = result.changed
      ? { mode: state.mode, path: state.path, suppress: config.traeUpdate.suppress }
      : null;
    console.log(
      `[trae-update] suppress=${config.traeUpdate.suppress} file=${state.mode ?? "(未设置)"} changed=${result.changed}`,
    );
  } catch (error) {
    traeUpdateStartupError = error?.message || String(error);
    console.error(`[trae-update] TRAE 设置文件无法读写：${traeUpdateStartupError}`);
  }

  // Assigned before the loop below and long before the first request in practice:
  // anything arriving in between would still be picked up, because the start-up
  // schedule reads the configuration as it is at that moment.
  rescheduleAutoCheckin = scheduleAutoCheckin;
  await scheduleAutoCheckin({ initialRun: true });
  await scheduleAppUpdateCheck({ initialRun: true });

  let autoKeepaliveTimer = null;
  let autoKeepaliveStartTimer = null;
  if (AUTO_KEEPALIVE_ENABLED) {
    const runScheduledKeepalive = async () => {
      if (
        switchInFlight ||
        loginStartInFlight ||
        oauthManager.isActive() ||
        insightsRefreshInFlight ||
        checkinInFlight ||
        keepaliveInFlight ||
        isInstallBusy()
      ) {
        return;
      }
      try {
        const cockpit = await resolveCockpitPolicy();
        if (cockpit.action !== "run") {
          console.log(
            `[keepalive] skipped because ${
              cockpit.action === "skip"
                ? "Cockpit Tools is running"
                : "the Cockpit Tools state could not be determined"
            }`,
          );
          return;
        }
        const result = await runAccountKeepalive(null, {
          force: false,
          reason: "scheduled",
        });
        console.log(
          `[keepalive] refreshed=${result.refreshed} skipped=${result.skipped} failed=${result.failed}`,
        );
        await notifyAccountsUpdated(cdpClient);
      } catch (error) {
        console.error(`[keepalive] scheduled run failed: ${error.message || error}`);
      }
    };
    autoKeepaliveStartTimer = setTimeout(runScheduledKeepalive, 20_000);
    autoKeepaliveStartTimer.unref?.();
    autoKeepaliveTimer = setInterval(
      runScheduledKeepalive,
      AUTO_KEEPALIVE_SWEEP_INTERVAL_MS,
    );
    autoKeepaliveTimer.unref?.();
  }

  async function shutdown() {
    clearTimeout(autoCheckinStartTimer);
    clearInterval(autoCheckinTimer);
    clearTimeout(autoKeepaliveStartTimer);
    clearInterval(autoKeepaliveTimer);
    cdpClient.stop().catch(() => {});
    // The panel holds a keep-alive connection, which would keep `server.close()`
    // pending and leave the port bound. A restart has to release it promptly,
    // otherwise the replacement daemon that is already waiting cannot listen.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  }

  daemonShutdown = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (true) {
    await delay(60_000);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
