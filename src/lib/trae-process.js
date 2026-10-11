import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runPowerShell(script, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeout,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout.trim();
}

export async function traeExecutableExists(exePath) {
  try {
    const stat = await fs.stat(exePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function isCdpAvailable(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function isTraeCdpAvailable(port, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const targets = await response.json();
    return targets.some((target) => {
      if (target.type !== "page") return false;
      const url = String(target.url || "").toLowerCase();
      const title = String(target.title || "").toLowerCase();
      return (
        url.includes("workbench") ||
        url.includes("vscode-file") ||
        title.includes("trae") ||
        title.includes("solo")
      );
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function findTraeWindowProcessIds(exePath) {
  const script = `
    $target = ${psQuote(exePath)}
    $items = @(Get-Process -Name 'Trae CN' -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne 0
    } | Select-Object -ExpandProperty Id)
    $items | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
}

export async function findTraeProcessIds(exePath) {
  const script = `
    $target = ${psQuote(exePath)}
    @(Get-Process -Name 'Trae CN' -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
}

/**
 * Image (executable) names that identify Cockpit Tools, without the `.exe`
 * suffix and lower-cased for comparison.
 */
export const COCKPIT_IMAGE_NAMES = [
  "cockpit tools",
  "cockpit-tools",
  "antigravity_cockpit_tools",
  "antigravity-cockpit-tools",
];

/** The executable base name, lower-cased and without the `.exe` suffix. */
export function normalizeImageBaseName(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const base = text.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.exe$/i, "").trim().toLowerCase();
}

export function isCockpitImageName(value) {
  const base = normalizeImageBaseName(value);
  return base !== "" && COCKPIT_IMAGE_NAMES.includes(base);
}

/**
 * `tasklist /FO CSV` wraps every field in double quotes. Only the first column
 * (the image name) matters here.
 */
export function parseTasklistImageNames(stdout) {
  const names = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let name;
    if (text.startsWith('"')) {
      const end = text.indexOf('"', 1);
      name = end > 0 ? text.slice(1, end) : "";
    } else {
      name = text.split(",")[0] ?? "";
    }
    name = name.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Layer 1 of the Cockpit probe.
 *
 * `tasklist.exe` is a native system binary, so it keeps working on a locked-down
 * machine where PowerShell execution is blocked by policy. That distinction is
 * the whole reason this layer exists first: on the intranet machine the
 * PowerShell-only probe threw, and the throw aborted an entire check-in sweep.
 */
async function probeCockpitByTasklist() {
  const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], {
    timeout: 15000,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const found = parseTasklistImageNames(stdout).filter(isCockpitImageName);
  return { running: found.length > 0, detail: found.join(", ") };
}

/** Layer 2: the PowerShell implementation carried over from v1.0.0. */
async function probeCockpitByPowerShell() {
  const script = `
    $names = @('Cockpit Tools', 'cockpit-tools', 'antigravity_cockpit_tools', 'antigravity-cockpit-tools')
    $items = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if (-not $items.Count) {
      $items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [System.IO.Path]::GetFileNameWithoutExtension($_.Path) -match '^(?i:Cockpit Tools|cockpit-tools)$'
      } | Select-Object -ExpandProperty Id)
    }
    $items | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(script);
  if (!output) return { running: false, detail: "" };
  const parsed = JSON.parse(output);
  const ids = (Array.isArray(parsed) ? parsed : [parsed]).filter(Number.isInteger);
  return { running: ids.length > 0, detail: ids.map(String).join(", ") };
}

const COCKPIT_PROBES = [
  { source: "tasklist", run: probeCockpitByTasklist },
  { source: "powershell", run: probeCockpitByPowerShell },
];

/**
 * Reports whether Cockpit Tools is running.
 *
 * `running` is a three-state value on purpose:
 *   - `true`  — definitively running
 *   - `false` — definitively not running
 *   - `null`  — every probe failed, so the answer is unknown
 *
 * `null` must never be collapsed into `false`. Both tools rotate the same
 * refresh tokens, so an unknown answer has to be handled with its own policy
 * instead of being treated as a green light.
 */
export async function probeCockpitTools() {
  const failures = [];
  for (const probe of COCKPIT_PROBES) {
    try {
      const result = await probe.run();
      return {
        running: result.running,
        source: probe.source,
        detail: result.detail,
        error: null,
        failures,
      };
    } catch (error) {
      failures.push({ source: probe.source, error: error?.message || String(error) });
    }
  }
  return {
    running: null,
    source: null,
    detail: "",
    error: failures.map((entry) => `${entry.source}: ${entry.error}`).join(" | "),
    failures,
  };
}

async function waitForExit(processIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(processIds);
  while (remaining.size && Date.now() < deadline) {
    for (const pid of [...remaining]) {
      try {
        process.kill(pid, 0);
      } catch {
        remaining.delete(pid);
      }
    }
    if (remaining.size) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [...remaining];
}

export async function stopTraeForRestart(exePath, { timeoutMs = 15000 } = {}) {
  const processIds = await findTraeProcessIds(exePath);
  if (!processIds.length) return [];

  const script = `
    $ids = @(${processIds.join(",")})
    Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object {
      try { [void]$_.CloseMainWindow() } catch {}
    }
  `;
  await runPowerShell(script);
  let remaining = await waitForExit(processIds, timeoutMs);
  if (!remaining.length) return [];

  await new Promise((resolve) => setTimeout(resolve, 300));

  const forceScript = `
    $ids = @(${remaining.join(",")})
    Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue
  `;
  await runPowerShell(forceScript);
  remaining = await waitForExit(remaining, 5000);
  if (remaining.length) {
    throw new Error(`Unable to stop Trae CN process(es): ${remaining.join(", ")}`);
  }
  return [];
}

export async function startTraeWithCdp(exePath, port) {
  const child = spawn(exePath, ["--new-window", `--remote-debugging-port=${port}`], {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child.pid || null;
}

/**
 * Brings the window of an already-running TRAE back to the front.
 *
 * PowerShell's own window handle for a process cannot be used for this: it only
 * ever reports a *visible* top-level window, so it answers 0 in exactly the case
 * this exists for — TRAE parked in the notification area with its window hidden.
 * That window is still alive, so the work has to be done by enumerating every
 * top-level window and keeping the ones owned by TRAE's own process ids.
 *
 * The returned `action` is more than a boolean on purpose. "A window is already in
 * front", "the window was minimized", "the process owns no window at all" and "the
 * probe itself failed" each call for a different response, and a boolean would
 * collapse the two that matter into the same answer.
 */
export async function focusTraeWindow(exePath) {
  const script = `
    $target = ${psQuote(exePath)}
    $pids = @(Get-Process -Name 'Trae CN' -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -ExpandProperty Id)
    if (-not $pids.Count) { Write-Output 'no-process'; exit 0 }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class TraeWindowFocus {
  public delegate bool EnumProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, System.Text.StringBuilder name, int maxCount);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr handle, bool altTab);

  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOACTIVATE = 0x0010;

  public static string Focus(uint[] processIds) {
    List<IntPtr> owned = new List<IntPtr>();
    IntPtr best = IntPtr.Zero;
    int bestRank = 99;
    TraeWindowFocus.EnumProc callback = delegate(IntPtr handle, IntPtr parameter) {
      uint owner = 0;
      GetWindowThreadProcessId(handle, out owner);
      if (Array.IndexOf(processIds, owner) < 0) { return true; }
      // The browser process also owns IME hosts, an input-method hint window and a
      // GDI+ hook window, and several of those carry a title. The window class is
      // what tells the real window apart: every TRAE window is a Chromium widget
      // and none of the helpers is.
      System.Text.StringBuilder className = new System.Text.StringBuilder(256);
      GetClassName(handle, className, 256);
      if (className.ToString() != "Chrome_WidgetWin_1") { return true; }
      // A Chromium widget with no title is a helper window too, not the one a user
      // means by "the TRAE window".
      if (GetWindowTextLength(handle) == 0) { return true; }
      owned.Add(handle);
      int rank = 2;
      if (IsWindowVisible(handle)) { rank = IsIconic(handle) ? 1 : 0; }
      if (rank < bestRank) { bestRank = rank; best = handle; }
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);

    if (owned.Count == 0) { return "no-window"; }
    IntPtr foreground = GetForegroundWindow();
    if (foreground != IntPtr.Zero && owned.Contains(foreground)) { return "already-foreground"; }

    string action;
    if (IsIconic(best)) { ShowWindow(best, 9); action = "restored"; }
    else if (!IsWindowVisible(best)) { ShowWindow(best, 5); action = "shown"; }
    else { action = "focused"; }

    BringWindowToTop(best);
    // Focus is one guarantee; z-order is a weaker one that needs no permission at
    // all. Toggling the window through the topmost band and back raises it above
    // every other window even for a caller that is refused the foreground, so the
    // panel becomes visible either way — which is what the click is asking for.
    SetWindowPos(best, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    SetWindowPos(best, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    // SetForegroundWindow is refused unless the caller is allowed to take the
    // foreground, and a helper started from a shortcut is not: the call returns
    // having changed nothing, which is how a click on the shortcut came to do
    // nothing visible at all. SwitchToThisWindow performs the same switch for a
    // caller that is not permitted, so it runs only as the fallback — it also
    // rewrites the Alt+Tab order, which a plain focus leaves alone.
    //
    // The older input-queue attach recipe this replaced is deliberately gone:
    // Microsoft documents that approach as unreliable for this exact job, and it
    // was observed to fail with the input queue attached where the plain call
    // succeeded.
    SetForegroundWindow(best);
    if (GetForegroundWindow() != best) SwitchToThisWindow(best, true);

    return GetForegroundWindow() == best ? action : action + "-unfocused";
  }
}
'@
    [TraeWindowFocus]::Focus($pids)
  `;
  try {
    const action = await runPowerShell(script, { timeout: 25000 });
    return { action: action || "unavailable", error: null };
  } catch (error) {
    return { action: "unavailable", error: error?.message || String(error) };
  }
}

export async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTraeCdpAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
