#!/usr/bin/env node
/**
 * User-facing control surface for the local enhancement service.
 *
 * Commands:
 *   start      Launch the full chain (TRAE with CDP + daemon + panel injection)
 *   daemon     Ensure the background service is up (daemon + watchdog);
 *              `--wait-pid <pid>` first waits for that pid to exit, which is how
 *              the panel restarts the daemon after a settings change
 *   stop       Stop the watchdog and the daemon by their exact pids
 *   restart    stop, then start the background service
 *   status     Print what is currently running
 *   locate     Show where TRAE was found, and every location that was probed
 *   configure  Save or clear the TRAE executable path, or write proxy settings
 *              (`--proxy-*`); writes the file only, so a running daemon has to
 *              be restarted whereas saving from the panel takes effect at once
 *   net        Probe the required hosts directly and, when a proxy is active,
 *              through that same dispatcher
 *   install    Register the logon autostart entry (background service only)
 *   uninstall  Remove the logon autostart entry
 *   tray       Start the tray icon host
 *   logs       Print the tail of the watchdog log
 *
 * With no arguments at all the `start` command runs, so double-clicking the
 * executable does something useful instead of flashing a one-shot report.
 *
 * Safety rules enforced here (see AGENTS.md):
 *   - only ever terminate the pid reported by /api/health or our own pid file;
 *   - refuse to terminate a pid that is not one of our own process images;
 *   - never touch TRAE processes from this CLI.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  APP_ROOT,
  IS_BUNDLED,
  TRAY_SCRIPT_PATH,
} from "../src/lib/app-paths.js";
import {
  daemonSpec,
  launcherSpec,
  serviceBaseArgs,
  watchdogAutostartPlan,
  watchdogSpec,
} from "../src/lib/launch-spec.js";
import {
  AUTOSTART_VBS_NAME,
  assertAscii,
  autostartVbsPath,
  buildAutostartVbs,
  buildShortcutScript,
  buildUninstallScript,
  psQuote,
  resolveStartupFolder,
  startupFolderFallback,
  startupShortcutPath,
} from "../src/lib/autostart.js";
import {
  normalizeProxy,
  normalizeTraeExe,
  configPath,
  loadAppConfig,
  saveAppConfig,
} from "../src/lib/app-config.js";
import {
  SOURCES,
  createWindowsProbe,
  detectTraeExe,
  formatNotFoundHelp,
  formatResolvedLine,
} from "../src/lib/trae-locate.js";
import {
  STATIC_HOSTS,
  describeProxyTestVerdict,
  formatProbeLine,
  probeHost,
  probeHosts,
  stripProxyEnv,
} from "../src/lib/net-diagnostics.js";
import { applyProxyConfig, getDispatcherFor } from "../src/lib/proxy-runtime.js";
import { PROXY_MODE_LABELS } from "../src/lib/system-proxy.js";
import {
  flagValue,
  parseServiceArgs,
} from "../src/lib/cli-args.js";
import { writeTextAtomic, readTextFile, writeJsonAtomic } from "../src/lib/json-file.js";
import { buildTrayConfig } from "../src/lib/tray-config.js";
import { loadAppIcon } from "../src/lib/app-icon.js";
import {
  DATA_DIR,
  DAEMON_LOG_PATH,
  HOST,
  LOG_DIR,
  SERVICE_LOG_PATH,
  TRAY_PID_PATH,
  UI_PORT,
  WATCHDOG_LOG_PATH,
  WATCHDOG_PID_PATH,
} from "../src/lib/runtime-paths.js";
import { createDaemonLogger } from "../src/lib/daemon-log.js";
import {
  isProcessAlive,
  isManagedProcessImage,
  isManagedProcessCommand,
  normalizePid,
  parseHealth,
  parsePidFile,
  summarizeStatus,
} from "../src/lib/service-control.js";

const execFileAsync = promisify(execFile);
const HEALTH_TIMEOUT_MS = 4000;
const STARTUP_WAIT_MS = 12000;
const TAIL_LINES = 40;
const TRAY_ICON_PATH = path.join(DATA_DIR, "tray.ico");
const TRAY_CONFIG_PATH = path.join(DATA_DIR, "tray-config.json");

function log(message) {
  console.log(message);
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

async function readWatchdogPid() {
  return await fs
    .readFile(WATCHDOG_PID_PATH, "utf8")
    .then(parsePidFile)
    .catch(() => null);
}

async function readTrayPid() {
  return await fs
    .readFile(TRAY_PID_PATH, "utf8")
    .then(parsePidFile)
    .catch(() => null);
}

/**
 * A pid alone is not proof of ownership: it may have been recycled. Confirm the
 * image name before terminating anything.
 */
async function describeProcess(pid) {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $p) { Write-Output '{}'; exit 0 }",
    `$c = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "[ordered]@{ name = $p.ProcessName; commandLine = $c.CommandLine; executablePath = $c.ExecutablePath } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 10000, encoding: "utf8", windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim() || "{}");
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      commandLine: typeof parsed.commandLine === "string" ? parsed.commandLine : "",
      executablePath: typeof parsed.executablePath === "string" ? parsed.executablePath : "",
    };
  } catch {
    return null;
  }
}

async function terminateManaged(pid, label, expectedKind) {
  const normalized = normalizePid(pid);
  if (normalized === null) {
    log(`${label}: no valid pid, nothing to stop`);
    return false;
  }
  if (!isProcessAlive(normalized)) {
    log(`${label}: pid ${normalized} is already gone`);
    return false;
  }
  const processInfo = await describeProcess(normalized);
  if (processInfo === null) {
    throw new Error(`${label}: unable to inspect pid ${normalized}`);
  }
  if (!processInfo.name) {
    log(`${label}: pid ${normalized} exited before it could be stopped`);
    return false;
  }
  if (!isManagedProcessImage(processInfo.name)) {
    throw new Error(
      `${label}: refusing to stop pid ${normalized} because it is "${processInfo.name}", not this project's process image`,
    );
  }
  if (
    !isManagedProcessCommand(processInfo.commandLine, expectedKind, {
      bundled: IS_BUNDLED,
    })
  ) {
    throw new Error(
      `${label}: refusing to stop pid ${normalized} because its command line is not this project's ${expectedKind}`,
    );
  }
  process.kill(normalized, "SIGTERM");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isProcessAlive(normalized)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (isProcessAlive(normalized)) {
    throw new Error(`${label}: pid ${normalized} did not stop within 8s`);
  }
  log(`${label}: stopped pid ${normalized}`);
  return true;
}

async function ensureWatchdog() {
  const existing = await readWatchdogPid();
  if (existing && isProcessAlive(existing)) {
    const processInfo = await describeProcess(existing);
    if (
      processInfo?.name &&
      isManagedProcessImage(processInfo.name) &&
      isManagedProcessCommand(processInfo.commandLine, "supervisor", {
        bundled: IS_BUNDLED,
      })
    ) {
      log(`background supervisor already running (pid ${existing})`);
      return existing;
    }
    log(`supervisor pid ${existing} does not belong to this project; replacing stale pid file`);
    await fs.rm(WATCHDOG_PID_PATH, { force: true }).catch(() => {});
  }
  const launch = watchdogSpec(["--quiet"]);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const claimed = await readWatchdogPid();
    if (claimed && isProcessAlive(claimed)) {
      log(`background supervisor started (pid ${claimed})`);
      return claimed;
    }
    if (child.pid && !isProcessAlive(child.pid)) {
      throw new Error("the background supervisor exited during startup");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log(`background supervisor started (pid ${child.pid ?? "unknown"})`);
  return child.pid ?? null;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readHealth();
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function commandStart(args = []) {
  log("starting Trae CN with CDP, the daemon, and the panel...");
  const launch = launcherSpec(args);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    stdio: "inherit",
    windowsHide: false,
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`the launcher exited with code ${code}`);
  const health = await readHealth();
  log(`ready: http://${HOST}:${UI_PORT}`);
  log(`accounts: ${health?.accountCount ?? 0}`);
}

/**
 * Brings the daemon up right away instead of waiting for the supervisor's
 * crash-recovery threshold. That threshold exists to avoid flapping and to not
 * race a daemon that is already booting, which makes it the wrong tool for a
 * user asking for the service to be started now.
 */
function spawnDaemonNow() {
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

/**
 * Waits for a pid to disappear, so a replacement daemon is not started while the
 * old one still holds the listening port.
 *
 * Used by the panel's "保存并重启": the daemon spawns this helper and then exits
 * itself, so the helper has to outlive its own parent. Polling `isProcessAlive`
 * avoids every privileged call (`tasklist`, PowerShell), which matters because
 * those are exactly what security policy blocks on managed machines.
 */
async function waitForPidExit(pid, { timeoutMs = 20000 } = {}) {
  const normalized = normalizePid(pid);
  if (normalized === null) {
    log(`--wait-pid: "${pid}" is not a valid pid, continuing immediately`);
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(normalized)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (isProcessAlive(normalized)) {
    log(`--wait-pid: pid ${normalized} is still alive after ${timeoutMs}ms`);
    return false;
  }
  return true;
}

async function commandDaemon(args = []) {
  const waitPid = flagValue(args, "--wait-pid");
  if (waitPid !== null) {
    const exited = await waitForPidExit(waitPid);
    if (!exited) log("旧守护进程仍未退出；如果它仍在响应，就继续沿用它。");
  }

  let health = await readHealth();
  if (health) {
    log(`daemon already running (pid ${health.pid})`);
  } else {
    const pid = spawnDaemonNow();
    log(`daemon was not running; started pid ${pid ?? "unknown"}`);
    health = await waitForHealth(STARTUP_WAIT_MS);
  }

  const watchdogPid = await ensureWatchdog();

  if (health) {
    log(`daemon ready: http://${HOST}:${UI_PORT} (pid ${health.pid})`);
  } else {
    log(
      `daemon did not answer within ${STARTUP_WAIT_MS}ms; the supervisor (pid ${watchdogPid ?? "unknown"}) keeps retrying`,
    );
  }
}

async function commandStop() {
  const watchdogPid = await readWatchdogPid();
  if (watchdogPid) {
    await terminateManaged(watchdogPid, "supervisor", "supervisor");
    await fs.rm(WATCHDOG_PID_PATH, { force: true }).catch(() => {});
  } else {
    log("supervisor: no pid file, nothing to stop");
  }
  const health = await readHealth();
  if (health) {
    await terminateManaged(health.pid, "daemon", "daemon");
  } else {
    log("daemon: not reachable, nothing to stop");
  }
  log("stopped");
}

async function commandStatus() {
  const [health, watchdogPid] = await Promise.all([readHealth(), readWatchdogPid()]);
  const startupFolder = resolveStartupFolderOrNull();
  const shortcutPath = startupFolder
    ? startupShortcutPath(startupFolder)
    : null;
  const autostartInstalled = shortcutPath
    ? await fs
        .access(shortcutPath)
        .then(() => true)
        .catch(() => false)
    : false;
  const status = summarizeStatus({
    health,
    watchdogPid: watchdogPid && isProcessAlive(watchdogPid) ? watchdogPid : null,
    autostartInstalled,
    logPath: WATCHDOG_LOG_PATH,
  });
  const lines = [
    `daemon      : ${status.daemon}${status.daemonPid ? ` (pid ${status.daemonPid})` : ""}`,
    `cdp         : ${status.cdpConnected ? "connected" : "disconnected"}`,
    `accounts    : ${status.accountCount ?? "unknown"}`,
    `keepalive   : ${status.keepaliveEnabled ? "enabled" : "disabled"}`,
    `supervisor  : ${status.watchdog}${status.watchdogPid ? ` (pid ${status.watchdogPid})` : ""}`,
    `autostart   : ${status.autostart}`,
    `log         : ${status.logPath}`,
    `endpoint    : http://${HOST}:${UI_PORT}`,
  ];
  log(lines.join("\n"));
}

function resolveStartupFolderOrNull() {
  try {
    return resolveStartupFolder();
  } catch {
    return startupFolderFallback();
  }
}

async function commandInstall() {
  const startupFolder = resolveStartupFolderOrNull();
  if (!startupFolder) throw new Error("unable to locate the Startup folder");
  await fs.mkdir(startupFolder, { recursive: true });

  const vbsPath = autostartVbsPath(APP_ROOT);
  const vbs = buildAutostartVbs({
    nodePath: process.execPath,
    ...watchdogAutostartPlan(),
  });
  assertAscii(vbs, "autostart vbs");
  await writeTextAtomic(vbsPath, vbs, { mode: 0o644 });
  log(`wrote ${path.basename(vbsPath)} (pure ASCII, resolves the project path at runtime)`);

  const shortcutPath = startupShortcutPath(startupFolder);
  const script = buildShortcutScript({
    shortcutPath,
    vbsPath,
    workingDirectory: APP_ROOT,
  });
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 20000, encoding: "buffer", windowsHide: true },
    );
    await fs.access(shortcutPath);
  } catch (error) {
    await fs.rm(vbsPath, { force: true }).catch(() => {});
    throw error;
  }
  log(`registered logon autostart: ${shortcutPath}`);
  log("the entry starts the background service only; TRAE still launches through this CLI");
}

async function commandUninstall() {
  const startupFolder = resolveStartupFolderOrNull();
  if (!startupFolder) throw new Error("unable to locate the Startup folder");
  const shortcutPath = startupShortcutPath(startupFolder);
  const script = buildUninstallScript({ shortcutPath });
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 20000, encoding: "utf8", windowsHide: true },
  );
  const vbsPath = autostartVbsPath(APP_ROOT);
  await fs.rm(vbsPath, { force: true }).catch(() => {});
  log(stdout.trim() || "autostart entry removed");
  log(`removed ${path.basename(vbsPath)} if it existed`);
}

async function commandLogs(args = []) {
  const requested = args.find((argument) => !argument.startsWith("-"));
  const targets = requested
    ? [path.join(LOG_DIR, `${requested}.log`)]
    : [DAEMON_LOG_PATH, WATCHDOG_LOG_PATH];
  let printed = 0;
  for (const target of targets) {
    const text = await readTextFile(target, { required: false });
    if (!text) {
      log(`--- ${path.basename(target)}: 暂无日志 ---`);
      continue;
    }
    const lines = text.trimEnd().split(/\r?\n/);
    log(`--- ${path.basename(target)} (最后 ${TAIL_LINES} 行) ---`);
    log(lines.slice(-TAIL_LINES).join("\n"));
    printed += 1;
  }
  if (!printed) {
    log(`日志目录: ${LOG_DIR}`);
    log("如果 daemon 是通过 start 启动的，它现在会把输出写进 daemon.log。");
  }
}

async function commandTray() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const existing = await readTrayPid();
  if (existing && isProcessAlive(existing)) {
    const processInfo = await describeProcess(existing);
    if (
      processInfo?.name &&
      isManagedProcessImage(processInfo.name) &&
      isManagedProcessCommand(processInfo.commandLine, "tray", {
        bundled: IS_BUNDLED,
      })
    ) {
      log(`tray host already running (pid ${existing})`);
      return;
    }
    await fs.rm(TRAY_PID_PATH, { force: true }).catch(() => {});
  }
  await fs.writeFile(TRAY_ICON_PATH, await loadAppIcon());
  const config = buildTrayConfig({
    nodePath: process.execPath,
    serviceArgs: serviceBaseArgs(),
    iconPath: TRAY_ICON_PATH,
    workingDirectory: APP_ROOT,
  });
  await writeJsonAtomic(TRAY_CONFIG_PATH, config);

  const commandLine = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    `"${TRAY_SCRIPT_PATH.replaceAll('"', '\\"')}"`,
    "-ConfigPath",
    `"${TRAY_CONFIG_PATH.replaceAll('"', '\\"')}"`,
  ].join(" ");
  const startScript = [
    "$ErrorActionPreference = 'Stop'",
    `$arguments = ${psQuote(commandLine)}`,
    "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden",
    "Write-Output $p.Id",
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startScript],
    { timeout: 20000, encoding: "utf8", windowsHide: true },
  );
  const trayPid = Number.parseInt(stdout.trim(), 10);

  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (!Number.isInteger(trayPid) || !isProcessAlive(trayPid)) {
    throw new Error(
      "the tray host exited immediately; run it manually to see the error:\n" +
        `  powershell -NoProfile -ExecutionPolicy Bypass -File "${TRAY_SCRIPT_PATH}" -ConfigPath "${TRAY_CONFIG_PATH}"`,
    );
  }
  await writeTextAtomic(TRAY_PID_PATH, `${trayPid}\n`, { mode: 0o600 });
  log(`tray host started (pid ${trayPid})`);
  log(`icon: ${TRAY_ICON_PATH}`);
  log("right-click the tray icon for service controls");
}

async function commandTrayStop() {
  const trayPid = await readTrayPid();
  if (!trayPid) {
    log("tray host: no pid file, nothing to stop");
    return;
  }
  await terminateManaged(trayPid, "tray host", "tray");
  await fs.rm(TRAY_PID_PATH, { force: true }).catch(() => {});
  log("tray host stopped");
}

async function commandLocate(args = []) {
  const probe = createWindowsProbe();
  const config = await loadAppConfig(DATA_DIR);

  if (args.includes("--resolved")) {
    // Installer-facing contract: one tab separated line, empty when unresolved.
    const result = await detectTraeExe({ configured: config.traeExe, probe });
    const line = formatResolvedLine(result);
    if (line) log(line);
    process.exitCode = line ? 0 : 3;
    return;
  }

  const result = await detectTraeExe({ configured: config.traeExe, probe, exhaustive: true });

  if (args.includes("--json")) {
    log(
      JSON.stringify(
        {
          resolved: result.path,
          source: result.source,
          configured: config.traeExe,
          configPath: configPath(DATA_DIR),
          attempts: result.attempts,
        },
        null,
        2,
      ),
    );
    return;
  }

  log(`配置文件    : ${configPath(DATA_DIR)}`);
  log(`配置中的路径: ${config.traeExe ?? "(未设置)"}`);
  log("");
  if (!result.path) {
    log(formatNotFoundHelp({ attempts: result.attempts, dataDir: DATA_DIR }));
    process.exitCode = 3;
    return;
  }
  log(`已解析: ${result.path}`);
  log(`来源  : ${SOURCES[result.source] ?? result.source}`);
  log("");
  log("全部探测记录:");
  for (const attempt of result.attempts) {
    log(
      `  [${attempt.exists ? "存在" : "缺失"}] ${SOURCES[attempt.source] ?? attempt.source} → ${attempt.value}`,
    );
  }
}


function parseHostArguments(args) {
  const hosts = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host" && args[index + 1]) hosts.push(String(args[index + 1]));
  }
  return hosts;
}

function formatNetworkReport({ hosts, direct, proxied, verdict, state }) {
  const lines = [];
  lines.push(`配置文件        : ${configPath(DATA_DIR)}`);
  lines.push(`代理模式        : ${PROXY_MODE_LABELS[state?.mode] ?? state?.mode ?? "off"}`);
  lines.push(`直连探测（${hosts.join(", ")}）:`);
  for (const result of direct) lines.push(`  ${formatProbeLine(result)}`);
  if (proxied) {
    lines.push("");
    lines.push(`走代理探测（${state.scheme}://${state.host}:${state.port}）:`);
    for (const result of proxied) lines.push(`  ${formatProbeLine(result)}`);
  }
  lines.push("");
  lines.push(`结论: ${verdict.text}`);
  return lines.join("\n");
}

async function commandNet(args = []) {
  const hosts = [...new Set([...STATIC_HOSTS, ...parseHostArguments(args)])];
  // The live dispatcher is built from the same configuration and with the same
  // rules the daemon uses, so this report describes the path requests actually
  // take rather than a bare direct connection that only the CLI can make.
  const state = await applyProxyConfig(await loadAppConfig(DATA_DIR));
  const direct = await probeHosts(hosts);
  const proxied = [];
  if (state.active) {
    for (const host of hosts) {
      proxied.push(await probeHost(host, { dispatcher: getDispatcherFor(`https://${host}/`) }));
    }
  }
  const verdict = describeProxyTestVerdict({ direct, proxied: proxied.length ? proxied : null });

  if (args.includes("--json")) {
    log(
      JSON.stringify(
        {
          hosts,
          direct,
          proxied: proxied.length ? proxied : null,
          proxy: {
            mode: state.mode,
            source: state.source,
            active: state.active,
            scheme: state.scheme,
            host: state.host,
            port: state.port,
            reason: state.reason,
            notes: state.notes,
          },
          conclusion: verdict.conclusion,
          severity: verdict.severity,
          conclusionText: verdict.text,
        },
        null,
        2,
      ),
    );
    return;
  }

  log(formatNetworkReport({ hosts, direct, proxied: proxied.length ? proxied : null, verdict, state }));
}

/**
 * The proxy flags accepted by `configure`.
 *
 * Only the file is written. The daemon reads its configuration at start-up and
 * on every panel save, so a value written here needs a restart to be picked up —
 * saying so is the whole point, because the panel's own save is immediate and
 * the two paths would otherwise look identical.
 */
const PROXY_FLAGS = [
  ["--proxy-mode", "mode"],
  ["--proxy-scheme", "scheme"],
  ["--proxy-host", "host"],
  ["--proxy-port", "port"],
  ["--proxy-user", "username"],
  ["--proxy-pass", "password"],
  ["--proxy-noproxy", "noProxy"],
];

/** Returns true when proxy flags were present and handled. */
async function configureProxy(args) {
  const touched = PROXY_FLAGS.filter(([flag]) => flagValue(args, flag) !== null);
  if (touched.length === 0) return false;

  if (args.includes("--proxy-pass")) {
    log("提示: 命令行里的密码会留在命令历史中，建议改用面板的「网络」设置页填写。");
  }

  const current = await loadAppConfig(DATA_DIR);
  const submitted = { ...current.proxy };
  for (const [flag, key] of touched) {
    const value = flagValue(args, flag);
    submitted[key] = key === "port" ? Number(value) : value;
  }

  let proxy;
  try {
    proxy = normalizeProxy(submitted);
  } catch (error) {
    log(`代理配置无效: ${error.message || String(error)}`);
    log("用法: configure --proxy-mode off|system|custom [--proxy-noproxy \"*.corp.example.com\"]");
    log("      configure --proxy-mode custom --proxy-scheme http|https|socks5 --proxy-host 127.0.0.1 --proxy-port 7890");
    log("              [--proxy-user <账号> --proxy-pass <密码>]");
    process.exitCode = 2;
    return true;
  }

  await saveAppConfig(DATA_DIR, { proxy });
  log(
    `已保存代理配置: ${PROXY_MODE_LABELS[proxy.mode]}` +
      `${proxy.mode === "custom" ? ` ${proxy.scheme}://${proxy.host}:${proxy.port}` : ""}`,
  );
  log(`配置文件        : ${configPath(DATA_DIR)}`);
  log("面板里保存会立即生效；命令行写入的配置需要重启守护进程后才会生效。");
  return true;
}

async function commandConfigure(args = []) {
  if (args.includes("--clear")) {
    await saveAppConfig(DATA_DIR, { traeExe: null });
    log(`已清除配置中的 TRAE 路径（${configPath(DATA_DIR)}）`);
    return;
  }

  if (await configureProxy(args)) return;

  const raw = flagValue(args, "--trae-exe");
  if (!raw) {
    log('用法: configure --trae-exe "D:\\路径\\Trae CN.exe"');
    log("      configure --clear");
    log("      configure --proxy-mode off|system|custom [--proxy-scheme ...] [--proxy-host ...] [--proxy-port ...]");
    process.exitCode = 2;
    return;
  }

  const normalized = normalizeTraeExe(raw);
  if (!normalized) throw new Error("提供的路径为空");
  const exists = await fs
    .stat(normalized)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!exists) {
    throw new Error(`指定的文件不存在，未写入配置：${normalized}`);
  }

  await saveAppConfig(DATA_DIR, { traeExe: normalized });
  log(`已保存 TRAE 路径: ${normalized}`);
  log(`配置文件        : ${configPath(DATA_DIR)}`);
  log("正在运行的 daemon 需要 restart 才会读取新路径。");
}

const COMMANDS = {
  start: commandStart,
  daemon: commandDaemon,
  stop: commandStop,
  restart: async () => {
    await commandStop();
    await commandDaemon();
  },
  status: commandStatus,
  locate: commandLocate,
  configure: commandConfigure,
  net: commandNet,
  install: commandInstall,
  uninstall: commandUninstall,
  tray: commandTray,
  "tray-stop": commandTrayStop,
  logs: commandLogs,
};

/**
 * A console opened by a double click disappears the moment the process exits.
 * Pausing is therefore limited to exactly the case that needs it: no command was
 * given and stdout really is a console. A piped or scripted call never pauses.
 */
let exitIsInteractive = false;

async function waitForEnter() {
  if (!process.stdin.isTTY) return;
  process.stdout.write("\n按回车键关闭此窗口...");
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });
}

/**
 * The bundled executable receives the internal dispatch flag as well, and it can
 * land before the command. `parseServiceArgs` drops those flags first so the
 * argument position is identical between `node scripts/service.js` and
 * `TraeMeta.exe`.
 */
async function main() {
  const { hasCommand, command, rest } = parseServiceArgs(process.argv);
  const handler = COMMANDS[command];

  exitIsInteractive = !hasCommand && Boolean(process.stdout.isTTY);

  if (!handler) {
    log(`unknown command "${command}"`);
    log(`available: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 2;
  } else {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await handler(rest);
  }

  if (exitIsInteractive) await waitForEnter();
}

/**
 * The installer only ever sees an exit code, so the failure has to leave a trace
 * on disk or the report is unfalsifiable. The whole chain matters: Node hides
 * the real reason for a transport failure in `cause`, and the bare message of a
 * config rejection does not say where it was thrown from.
 */
function describeErrorChain(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.stack || current.message);
    current = current.cause;
  }
  return parts.length ? parts.join("\n  caused by: ") : String(error);
}

const serviceLogger = createDaemonLogger({ logPath: SERVICE_LOG_PATH, mirror: false });

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  serviceLogger.error(describeErrorChain(error));
  if (exitIsInteractive) await waitForEnter();
});
