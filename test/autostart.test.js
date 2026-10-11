import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAscii,
  asciiLiteralOrFallback,
  autostartVbsPath,
  buildAutostartVbs,
  buildShortcutScript,
  buildUninstallScript,
  findNonAscii,
  psQuote,
  resolveStartupFolder,
  startupFolderFallback,
  startupShortcutPath,
  vbsQuote,
} from "../src/lib/autostart.js";

const CHINESE_ROOT = "D:\\Me\\副业\\Trae多账号协同";
const ASCII_ROOT = "D:\\apps\\trae-enhancer";

test("non-ASCII detection finds the first offending character", () => {
  assert.equal(findNonAscii("plain ascii"), null);
  assert.deepEqual(findNonAscii("a中b"), { index: 1, char: "中" });
  assert.equal(findNonAscii(null), null);
});

test("assertAscii rejects non-ASCII content", () => {
  assert.equal(assertAscii("safe", "label"), "safe");
  assert.throws(() => assertAscii("副业", "the vbs"), /must be pure ASCII/);
});

test("vbs string literals double quotes but never escape backslashes", () => {
  assert.equal(vbsQuote("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
  assert.equal(vbsQuote("a\"b"), '"a""b"');
  assert.equal(findNonAscii(vbsQuote("C:\\Program Files\\node.exe")), null);
});

test("the autostart vbs stays pure ASCII for a non-ASCII project path", () => {
  const vbs = buildAutostartVbs({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    relativeScriptPath: "scripts\\watchdog.js",
  });
  assert.equal(findNonAscii(vbs), null);
  assert.equal(vbs.includes("副业"), false);
  assert.equal(vbs.includes("Trae多账号协同"), false);
});

test("source mode resolves the watchdog relative to the project root", () => {
  const vbs = buildAutostartVbs({ nodePath: "C:\\nodejs\\node.exe" });
  assert.match(vbs, /GetParentFolderName\(WScript\.ScriptFullName\)/);
  assert.match(vbs, /root = fso\.GetParentFolderName\(here\)/);
  assert.match(vbs, /scriptPath = root & "\\" & "scripts\\watchdog\.js"/);
  assert.match(vbs, /sh\.CurrentDirectory = root/);
  assert.match(vbs, /sh\.Run Chr\(34\)/);
});

test("bundled mode resolves the executable from its own folder, not from an absolute path", () => {
  const vbs = buildAutostartVbs({
    nodePath: "D:\\Me\\副业\\Trae多账号协同\\dist\\portable\\TraeMeta.exe",
    bundled: true,
    flags: ["--internal-watchdog", "--quiet"],
  });
  assert.equal(findNonAscii(vbs), null);
  assert.match(vbs, /--internal-watchdog --quiet/);
  assert.match(vbs, /nodeExe = root & "\\" & "TraeMeta\.exe"/);
  assert.equal(vbs.includes("scriptPath = root"), false);
  assert.equal(vbs.includes("fso.FileExists(scriptPath)"), false);
  assert.equal(vbs.includes('nodeExe = "node.exe"'), false);
  assert.match(vbs, /If Not fso\.FileExists\(nodeExe\) Then WScript\.Quit 2/);
  assert.match(vbs, /, 0, False$/m);
});

test("bundled mode keeps a renamed executable name instead of hardcoding one", () => {
  const vbs = buildAutostartVbs({
    nodePath: "C:\\app\\MyEnhancer.exe",
    bundled: true,
    flags: ["--internal-watchdog"],
  });
  assert.match(vbs, /nodeExe = root & "\\" & "MyEnhancer\.exe"/);
});

test("bundled mode refuses an executable name it cannot embed safely", () => {
  assert.throws(
    () => buildAutostartVbs({ nodePath: "C:\\app\\增强器.exe", bundled: true }),
    /must be pure ASCII/,
  );
});

test("the autostart vbs hides its window and fails loudly when the watchdog is missing", () => {
  const vbs = buildAutostartVbs({ nodePath: "C:\\nodejs\\node.exe" });
  assert.match(vbs, /If Not fso\.FileExists\(scriptPath\) Then WScript\.Quit 1/);
  assert.match(vbs, /sh\.Run Chr\(34\)/);
  assert.match(vbs, /, 0, False$/m);
  assert.match(vbs, /--quiet/);
});

test("the autostart vbs keeps single backslashes in the embedded node path", () => {
  const vbs = buildAutostartVbs({ nodePath: "C:\\Program Files\\nodejs\\node.exe" });
  assert.equal(vbs.includes('"C:\\Program Files\\nodejs\\node.exe"'), true);
  assert.equal(vbs.includes("C:\\\\Program Files"), false);
});

test("a non-ASCII node path falls back to a PATH lookup instead of corrupting the source", () => {
  const vbs = buildAutostartVbs({ nodePath: "D:\\工具\\nodejs\\node.exe" });
  assert.equal(findNonAscii(vbs), null);
  assert.equal(vbs.includes('nodeExe = "node.exe"'), true);
  assert.equal(asciiLiteralOrFallback("D:\\工具\\node.exe", "node.exe"), "node.exe");
  assert.equal(asciiLiteralOrFallback("C:\\nodejs\\node.exe", "node.exe"), "C:\\nodejs\\node.exe");
});

test("every generated vbs line has balanced double quotes", () => {
  const samples = [
    buildAutostartVbs({ nodePath: "C:\\Program Files\\nodejs\\node.exe" }),
    buildAutostartVbs({
      nodePath: "D:\\Me\\副业\\Trae多账号协同\\dist\\portable\\TraeMeta.exe",
      bundled: true,
      flags: ["--internal-watchdog", "--quiet"],
    }),
    buildAutostartVbs({ nodePath: "D:\\工具\\node.exe" }),
  ];
  for (const vbs of samples) {
    for (const line of vbs.split("\r\n")) {
      const quotes = [...line].filter((char) => char === '"').length;
      assert.equal(quotes % 2, 0, `unbalanced quotes in: ${line}`);
    }
  }
});

test("the generated vbs creates the shell objects it later uses", () => {
  const vbs = buildAutostartVbs({ nodePath: "C:\\nodejs\\node.exe" });
  assert.match(vbs, /Set fso = CreateObject\("Scripting\.FileSystemObject"\)/);
  assert.match(vbs, /Set sh = CreateObject\("WScript\.Shell"\)/);
  assert.equal(vbs.includes("Option Explicit"), true);
  assert.equal(vbs.startsWith("Option Explicit\r\n"), true);
});

test("the generated vbs ends with a newline and hides its window in both shapes", () => {
  for (const bundled of [false, true]) {
    const vbs = buildAutostartVbs({ nodePath: "C:\\nodejs\\node.exe", bundled });
    assert.equal(vbs.endsWith("\r\n"), true);
    assert.match(vbs, /sh\.Run .*", 0, False\r\n$/);
  }
});

test("the shortcut script may carry a non-ASCII path because it is never a file", () => {
  const script = buildShortcutScript({
    shortcutPath: `${CHINESE_ROOT}\\.lnk`,
    vbsPath: autostartVbsPath(CHINESE_ROOT),
    workingDirectory: CHINESE_ROOT,
  });
  assert.equal(findNonAscii(script) !== null, true);
  assert.match(script, /wscript\.exe/);
  assert.match(script, /Join-Path \$env:SystemRoot/);
  assert.match(script, /\$link\.WindowStyle = 7/);
  assert.match(script, /throw 'the shortcut was not created'/);
});

test("the shortcut script escapes single quotes in PowerShell literals", () => {
  const script = buildShortcutScript({
    shortcutPath: "C:\\it's here\\a.lnk",
    vbsPath: "C:\\it's here\\a.vbs",
    workingDirectory: "C:\\it's here",
  });
  assert.match(script, /'C:\\it''s here\\a\.lnk'/);
  assert.equal(psQuote("it's"), "'it''s'");
});

test("the uninstall script reports whether the shortcut really disappeared", () => {
  const script = buildUninstallScript({ shortcutPath: `${CHINESE_ROOT}\\x.lnk` });
  assert.match(script, /Remove-Item -LiteralPath \$target -Force/);
  assert.match(script, /Write-Output \('removed=' \+ \(-not \$remaining\)\)/);
});

test("the startup folder is derived from APPDATA", () => {
  assert.equal(
    resolveStartupFolder({ APPDATA: "C:\\Users\\ZHD\\AppData\\Roaming" }),
    "C:\\Users\\ZHD\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
  );
  assert.throws(() => resolveStartupFolder({}), /APPDATA is not set/);
  assert.equal(
    startupFolderFallback({ USERPROFILE: "C:\\Users\\ZHD" }),
    "C:\\Users\\ZHD\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
  );
  assert.equal(startupFolderFallback({}), null);
});

test("the startup shortcut keeps the .lnk extension", () => {
  assert.equal(
    startupShortcutPath("C:\\Startup"),
    "C:\\Startup\\Trae Meta.lnk",
  );
});

test("the autostart vbs lives next to the other scripts", () => {
  assert.equal(
    autostartVbsPath(ASCII_ROOT),
    "D:\\apps\\trae-enhancer\\scripts\\daemon-autostart.vbs",
  );
});
