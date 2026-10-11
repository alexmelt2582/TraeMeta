/**
 * Autostart installation helpers.
 *
 * Two different encoding rules apply here and they must not be mixed up:
 *
 * 1. `daemon-autostart.vbs` is written to disk and read by `wscript.exe` as
 *    ANSI, so its source must stay pure ASCII. The project path is therefore
 *    never embedded; the script resolves it from its own location at runtime.
 *    VBScript has no backslash escape, so paths must not go through
 *    `JSON.stringify` (which would emit `\\` and corrupt them).
 * 2. The shortcut-creation PowerShell script is passed as a `-Command`
 *    argument, which travels as UTF-16 on the process command line. Non-ASCII
 *    paths are safe there and must not be ASCII-restricted.
 *
 * The `.lnk` file itself stores paths as UTF-16 through the COM API, so it is
 * the only artifact allowed to contain the non-ASCII project path.
 */
import path from "node:path";

export const AUTOSTART_VBS_NAME = "daemon-autostart.vbs";
export const AUTOSTART_SHORTCUT_NAME = "Trae Meta";

/**
 * The user-facing entry point for a packaged build.
 *
 * The bundled binary is a console-subsystem program, so launching it directly
 * always opens a console window. `wscript.exe` runs this with no console of its
 * own, and the window style handed to `sh.Run` keeps the child hidden as well.
 * The shortcuts the installer creates point here rather than at the executable.
 *
 * Only the launch entry is hidden. Commands such as `stop` keep their console on
 * purpose: the user asked for something to happen and should see it reported.
 */
export const LAUNCH_VBS_NAME = "launch-hidden.vbs";

const NON_ASCII = /[^\x00-\x7f]/;

export function findNonAscii(text) {
  if (typeof text !== "string") return null;
  const match = NON_ASCII.exec(text);
  return match ? { index: match.index, char: match[0] } : null;
}

export function assertAscii(text, label) {
  const found = findNonAscii(text);
  if (found) {
    throw new Error(
      `${label} must be pure ASCII but contains ${JSON.stringify(found.char)} at offset ${found.index}`,
    );
  }
  return text;
}

/** VBScript string literal: double quotes are doubled, backslashes are literal. */
export function vbsQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/** PowerShell single-quoted literal: single quotes are doubled. */
export function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * A literal path can only be embedded in the VBS when it is ASCII. When it is
 * not, fall back to a bare executable name so the generated source stays ASCII
 * and the loader resolves the binary through PATH.
 */
export function asciiLiteralOrFallback(value, fallback) {
  return typeof value === "string" && value.length > 0 && !findNonAscii(value) ? value : fallback;
}

export function resolveStartupFolder(env = process.env) {
  const appData = env.APPDATA;
  if (!appData) throw new Error("APPDATA is not set; cannot locate the Startup folder");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function startupFolderFallback(env = process.env) {
  const userProfile = env.USERPROFILE;
  if (!userProfile) return null;
  return path.join(
    userProfile,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

export function startupShortcutPath(startupFolder, name = AUTOSTART_SHORTCUT_NAME) {
  return path.join(startupFolder, `${name}.lnk`);
}

export function autostartVbsPath(projectRoot) {
  return path.join(projectRoot, "scripts", AUTOSTART_VBS_NAME);
}

export function launchVbsPath(projectRoot) {
  return path.join(projectRoot, "scripts", LAUNCH_VBS_NAME);
}

/**
 * The text shown when the launcher cannot find the executable. It must stay pure
 * ASCII because the script is written as ANSI, and it must not interpolate a path
 * because the project path can contain non-ASCII characters — the script appends
 * its own resolved path instead.
 */
export const LAUNCH_MISSING_EXE_MESSAGE =
  "Trae Meta cannot start: TraeMeta.exe was not found next to this script. "
  + "Re-extract the package, or restore the file if antivirus removed it.";

/**
 * The single definition of the no-console launcher, shared by the build and its
 * test so the two cannot drift apart.
 *
 * The desktop and start-menu shortcuts point here rather than at the executable:
 * the executable is a console-subsystem program, so launching it directly always
 * opens a console window. Everything specific to that use — the `start` argument,
 * the bundled shape, the visible error when the executable is gone — lives here.
 */
export function buildLaunchVbs({ nodePath }) {
  return buildAutostartVbs({
    nodePath,
    bundled: true,
    flags: ["start"],
    missingExeMessage: LAUNCH_MISSING_EXE_MESSAGE,
  });
}

/**
 * Window style 0 keeps the watchdog fully hidden when it starts at logon.
 *
 * Two shapes are supported and they are not interchangeable:
 * - source checkout: the watchdog is a sibling script, resolved relative to the
 *   project root at runtime so no non-ASCII path enters this source;
 * - bundled executable: the watchdog lives inside the executable and is reached
 *   through the internal argv switch, so there is no script path at all and
 *   falling back to a bare `node.exe` would be wrong.
 *
 * `missingExeMessage` turns the "executable is gone" case from a silent no-op
 * into a visible one. It matters for the desktop/start-menu launcher: when the
 * file was quarantined by antivirus, skipped by a partial extraction, or moved
 * by hand, a double-click would otherwise do nothing at all and the user has no
 * way to tell a broken install from a launcher that never ran. It stays unset
 * for the logon entry on purpose — a modal box on every logon would be worse
 * than the silence. The text must be pure ASCII: the file is written as ANSI.
 */
export function buildAutostartVbs({
  nodePath,
  bundled = false,
  relativeScriptPath = "scripts\\watchdog.js",
  flags = ["--quiet"],
  missingExeMessage = "",
}) {
  const node = asciiLiteralOrFallback(nodePath, "node.exe");
  const suffix = flags.length ? ` ${flags.join(" ")}` : "";
  const lines = [
    "Option Explicit",
    "Dim fso, sh, here, root, nodeExe, scriptPath",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    "here = fso.GetParentFolderName(WScript.ScriptFullName)",
    "root = fso.GetParentFolderName(here)",
  ];

  // Spelled out as a block rather than `If cond Then stmt : stmt`. VBScript's
  // single-line If treats everything up to the end of the line as its clause, so
  // the colon form reads as one statement and silently does the opposite of what
  // it looks like. A failure path that must always fire is not the place to rely
  // on that reading.
  const guard = (condition, exitCode) => {
    if (!missingExeMessage) {
      lines.push(`If ${condition} Then WScript.Quit ${exitCode}`);
      return;
    }
    lines.push(`If ${condition} Then`);
    lines.push(`  MsgBox ${vbsQuote(missingExeMessage)} & vbCrLf & vbCrLf & nodeExe, 48, "Trae Meta"`);
    lines.push(`  WScript.Quit ${exitCode}`);
    lines.push("End If");
  };

  if (bundled) {
    // The executable path may contain non-ASCII characters and therefore cannot
    // be embedded. Only the file name is written, and it is resolved against the
    // root this script already computes. A non-ASCII file name is reported
    // instead of being replaced by a wrong one, because that would register an
    // autostart entry that silently quits.
    const exeName = path.basename(nodePath);
    if (findNonAscii(exeName)) {
      throw new Error(
        `the executable name must be pure ASCII to register autostart, got ${JSON.stringify(exeName)}`,
      );
    }
    lines.push(`nodeExe = root & "\\" & ${vbsQuote(exeName)}`);
    guard("Not fso.FileExists(nodeExe)", 2);
    lines.push("sh.CurrentDirectory = root");
    lines.push(`sh.Run Chr(34) & nodeExe & Chr(34) & ${vbsQuote(suffix)}, 0, False`);
  } else {
    lines.push(`nodeExe = ${vbsQuote(node)}`);
    lines.push('If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"');
    lines.push(`scriptPath = root & "\\" & ${vbsQuote(relativeScriptPath)}`);
    guard("Not fso.FileExists(scriptPath)", 1);
    lines.push("sh.CurrentDirectory = root");
    lines.push(
      `sh.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & scriptPath & Chr(34) & ${vbsQuote(suffix)}, 0, False`,
    );
  }

  lines.push("");
  return assertAscii(lines.join("\r\n"), "autostart vbs");
}

/**
 * The non-ASCII project path is intentionally allowed here: this script never
 * becomes a file, it travels as a UTF-16 command line argument.
 */
export function buildShortcutScript({
  shortcutPath,
  vbsPath,
  workingDirectory,
  description = "Trae Meta background service",
}) {
  const wscript = "System32\\wscript.exe";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${psQuote(shortcutPath)})`,
    `$link.TargetPath = (Join-Path $env:SystemRoot ${psQuote(wscript)})`,
    `$link.Arguments = '"' + ${psQuote(vbsPath)} + '"'`,
    `$link.WorkingDirectory = ${psQuote(workingDirectory)}`,
    "$link.WindowStyle = 7",
    `$link.Description = ${psQuote(description)}`,
    "$link.Save()",
    `if (-not (Test-Path -LiteralPath ${psQuote(shortcutPath)})) { throw 'the shortcut was not created' }`,
    `$actual = $shell.CreateShortcut(${psQuote(shortcutPath)})`,
    "if (-not $actual.TargetPath) { throw 'the shortcut has no target' }",
    "Write-Output ('target=' + $actual.TargetPath)",
    "Write-Output ('args=' + $actual.Arguments)",
    "",
  ].join("\n");
}

export function buildUninstallScript({ shortcutPath }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${psQuote(shortcutPath)}`,
    "if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }",
    "$remaining = Test-Path -LiteralPath $target",
    "Write-Output ('removed=' + (-not $remaining))",
    "",
  ].join("\n");
}
