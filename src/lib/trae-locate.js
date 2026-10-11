/**
 * Locates the Trae CN executable.
 *
 * The install path is never assumed to be the default one. Detection walks a
 * fixed priority list and records where every probed value came from, so a
 * failure can be explained instead of guessed at:
 *
 *   1. an explicit `--trae-exe` argument
 *   2. the saved configuration file
 *   3. the `TRAEMETA_ENHANCER_TRAE_EXE` environment variable
 *   4. the path of a running TRAE process  (most reliable when TRAE is open)
 *   5. the uninstall registry entries
 *   6. well-known installation directories
 *
 * All probing is injected through a `probe` object so the whole resolution can
 * be unit tested without PowerShell or a real installation.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadAppConfig, configPath } from "./app-config.js";

const execFileAsync = promisify(execFile);

export const TRAE_EXE_NAME = "Trae CN.exe";
export const TRAE_PROCESS_NAME = "Trae CN";

export const SOURCES = {
  explicit: "命令行参数 --trae-exe",
  config: "配置文件 config.json",
  env: "环境变量 TRAEMETA_ENHANCER_TRAE_EXE",
  process: "运行中的 TRAE 进程",
  registry: "注册表卸载项",
  candidate: "常见安装位置",
};

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Turns a registry `DisplayIcon` value into an executable path. The value is
 * `"C:\path\app.exe",0` often enough that the suffix and quotes must be handled.
 */
export function displayIconToExePath(displayIcon) {
  if (typeof displayIcon !== "string") return null;
  let value = displayIcon.trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    value = end > 0 ? value.slice(1, end) : value.slice(1);
  } else {
    value = value.replace(/,\s*-?\d+\s*$/, "");
  }
  value = value.trim();
  if (!value || path.extname(value).toLowerCase() !== ".exe") return null;
  return path.normalize(value);
}

export function candidateTraePaths(env = process.env) {
  const local = env.LOCALAPPDATA;
  const roaming = env.APPDATA;
  const roots = [
    local && path.join(local, "Programs", TRAE_PROCESS_NAME),
    local && path.join(local, "Programs"),
    local,
    env.ProgramFiles && path.join(env.ProgramFiles, TRAE_PROCESS_NAME),
    env.ProgramFiles,
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], TRAE_PROCESS_NAME),
    env["ProgramFiles(x86)"],
    roaming,
    env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Local", "Programs", TRAE_PROCESS_NAME),
    env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Local", "Programs"),
  ].filter(Boolean);

  const seen = new Set();
  const candidates = [];
  for (const root of roots) {
    const value = path.join(root, TRAE_EXE_NAME);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(value);
  }
  return candidates;
}

/** Case-insensitive comparison of a path's file name against the product exe. */
export function matchesProductExeName(candidate) {
  return (
    typeof candidate === "string" &&
    path.basename(candidate).toLowerCase() === TRAE_EXE_NAME.toLowerCase()
  );
}

/**
 * The merged TRAE client registers as `TRAE CN (User)`, so the display name is
 * matched strictly on `Trae CN`. A looser rule such as `/TRAE/` would also admit
 * the other two Trae-branded installs on this machine — the legacy `TraeWork CN`
 * workspace and the `TraeCode CN` build — and the wrong executable would break
 * every flow that restarts TRAE. Both of those insert a word between `Trae` and
 * `CN`, so a plain substring test already excludes them.
 */
export function isProductDisplayName(displayName) {
  return typeof displayName === "string" && /Trae CN/i.test(displayName);
}

function registryCandidates(entries) {
  const candidates = [];
  for (const entry of asArray(entries)) {
    if (!entry || typeof entry !== "object") continue;
    const fromIcon = displayIconToExePath(entry.DisplayIcon);
    const iconMatches = Boolean(fromIcon) && matchesProductExeName(fromIcon);
    if (!iconMatches && !isProductDisplayName(entry.DisplayName)) continue;
    if (iconMatches) candidates.push(fromIcon);
    if (typeof entry.InstallLocation === "string" && entry.InstallLocation.trim()) {
      candidates.push(path.join(entry.InstallLocation.trim(), TRAE_EXE_NAME));
    }
  }
  return candidates;
}

/**
 * Yields candidates in priority order. The process and registry sources are only
 * queried when the generator actually reaches them, so a resolved configuration
 * never pays for a PowerShell round trip.
 */
async function* sourceValues({ explicit, configured, env, probe }) {
  yield { value: explicit, source: "explicit" };
  yield { value: configured, source: "config" };
  yield { value: env.TRAEMETA_ENHANCER_TRAE_EXE, source: "env" };
  for (const value of await probe.runningProcessPaths()) {
    yield { value, source: "process" };
  }
  for (const value of registryCandidates(await probe.uninstallEntries())) {
    yield { value, source: "registry" };
  }
  for (const value of candidateTraePaths(env)) {
    yield { value, source: "candidate" };
  }
}

/**
 * Returns `{ path, source, attempts }`.
 *
 * By default probing stops at the first existing candidate, which is what the
 * launcher wants. `exhaustive` keeps going to the end so a diagnostic can show
 * every location that was considered, while still reporting the same
 * highest-priority match.
 */
export async function detectTraeExe({
  explicit = null,
  configured = null,
  env = process.env,
  probe,
  exhaustive = false,
}) {
  const attempts = [];
  const checked = new Set();
  let hit = null;

  for await (const { value, source } of sourceValues({ explicit, configured, env, probe })) {
    if (typeof value !== "string" || !value.trim()) continue;
    const candidate = path.normalize(value.trim());
    const key = candidate.toLowerCase();
    if (checked.has(key)) continue;
    checked.add(key);
    const exists = await probe.isFile(candidate);
    attempts.push({ source, value: candidate, exists });
    if (exists && !hit) hit = { path: candidate, source };
    if (hit && !exhaustive) break;
  }

  if (!hit) return { path: null, source: null, attempts };
  return { path: hit.path, source: hit.source, attempts };
}

export async function resolveTraeExe({
  dataDir,
  env = process.env,
  probe,
  explicit = null,
  exhaustive = false,
}) {
  const config = await loadAppConfig(dataDir);
  const result = await detectTraeExe({
    explicit,
    configured: config.traeExe,
    env,
    probe,
    exhaustive,
  });
  return { ...result, configured: config.traeExe };
}

/**
 * A single PowerShell round trip gathers both the running process paths and the
 * uninstall entries, so detection does not spawn a shell per source.
 */
async function windowsSnapshot() {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$proc = @(Get-Process -Name '${TRAE_PROCESS_NAME}' | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique)`,
    "$keys = @(",
    "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ")",
    // The filter admits the merged install, whose DisplayName is "TRAE CN (User)".
    // The DisplayIcon pattern is a second, drive-independent signal that keys on
    // the executable name rather than on how the product brands itself.
    "$uninstall = @(Get-ItemProperty $keys | Where-Object { ($_.DisplayName -match 'Trae CN') -or ($_.DisplayIcon -match 'Trae CN\\.exe') } | Select-Object DisplayName, InstallLocation, DisplayIcon)",
    "[ordered]@{ processPaths = $proc; uninstall = $uninstall } | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 20000, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const text = stdout.trim();
  if (!text) return { processPaths: [], uninstall: [] };
  const parsed = JSON.parse(text);
  return {
    processPaths: asArray(parsed?.processPaths).filter((value) => typeof value === "string"),
    uninstall: asArray(parsed?.uninstall),
  };
}

export function createWindowsProbe() {
  let snapshotPromise = null;
  const snapshot = () => {
    snapshotPromise ??= windowsSnapshot().catch(() => ({ processPaths: [], uninstall: [] }));
    return snapshotPromise;
  };
  return {
    async isFile(candidate) {
      try {
        const stat = await fs.stat(candidate);
        return stat.isFile();
      } catch {
        return false;
      }
    },
    async runningProcessPaths() {
      return (await snapshot()).processPaths;
    },
    async uninstallEntries() {
      return (await snapshot()).uninstall;
    },
  };
}

/**
 * Machine-readable single line: `<path>\t<source key>`, or an empty string when
 * nothing was found.
 *
 * The source is emitted as its stable ASCII key rather than its Chinese label.
 * A consumer that reads this through a pipe decodes bytes with the system ANSI
 * code page, so a UTF-8 label would come back as mojibake. Callers that want a
 * localized label map the key themselves.
 */
export function formatResolvedLine(result) {
  if (!result || !result.path) return "";
  return `${result.path}\t${result.source ?? ""}`;
}

export function formatNotFoundHelp({ attempts, dataDir }) {
  const lines = [
    "找不到 Trae CN 的可执行文件。已探测以下位置：",
  ];
  for (const attempt of attempts) {
    lines.push(
      `  [${attempt.exists ? "存在" : "缺失"}] ${SOURCES[attempt.source] ?? attempt.source} → ${attempt.value}`,
    );
  }
  lines.push("");
  lines.push("请手动指定一次，之后会记住：");
  lines.push('  TraeMeta.exe configure --trae-exe "D:\\你的路径\\Trae CN.exe"');
  lines.push(`配置文件位置：${configPath(dataDir)}`);
  return lines.join("\n");
}
