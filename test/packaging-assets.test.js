import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_VERSION } from "../src/constants.js";
import { buildAutostartVbs, buildLaunchVbs } from "../src/lib/autostart.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const LANGUAGE_SHA256 = "bf0751fa176569c6faa2f6e17ed2734617bef325d5cc06eae030fdd0258ee778";

async function read(relativePath) {
  return await fs.readFile(path.join(PROJECT_ROOT, relativePath));
}

test("entry scripts stay pure ASCII without a BOM", async () => {
  for (const relativePath of ["scripts/trae-meta.cmd", "scripts/tray.ps1"]) {
    const bytes = await read(relativePath);
    assert.equal(bytes.subarray(0, 3).equals(UTF8_BOM), false, relativePath);
    assert.equal(bytes.some((byte) => byte > 0x7f), false, relativePath);
  }
});

test("the packaged launcher hides its console and stays pure ASCII", () => {
  // Exactly what `npm run build:exe` writes — same builder, so this cannot drift.
  const vbs = buildLaunchVbs({
    nodePath: path.join(PROJECT_ROOT, "dist", "portable", "TraeMeta.exe"),
  });
  // wscript.exe reads a .vbs as ANSI, so a non-ASCII byte here would be mojibake.
  assert.equal(Buffer.from(vbs, "utf8").some((byte) => byte > 0x7f), false);
  // The project path may contain non-ASCII characters and must never be embedded;
  // the script resolves its own location at runtime instead.
  assert.equal(vbs.includes(PROJECT_ROOT), false, "the project path must not be embedded");
  // Window style 0 and no wait: this is what keeps the console from appearing.
  assert.ok(vbs.includes(", 0, False"), "the launch must use a hidden window style");
  assert.ok(vbs.includes('" start"'), "the launch must run the start command");
});

test("the packaged launcher reports a missing executable instead of doing nothing", () => {
  const vbs = buildLaunchVbs({
    nodePath: path.join(PROJECT_ROOT, "dist", "portable", "TraeMeta.exe"),
  });

  // A desktop shortcut that silently quits is indistinguishable from one that
  // never ran: a quarantined executable or a partial extraction has to be said
  // out loud, and the box must still exit afterwards.
  assert.match(
    vbs,
    /If Not fso\.FileExists\(nodeExe\) Then\r\n\s+MsgBox .+?\r\n\s+WScript\.Quit 2\r\nEnd If/,
  );
  // The resolved path is appended by the script, never baked in.
  assert.ok(vbs.includes("& vbCrLf & vbCrLf & nodeExe"), "the dialog must name the path it looked in");
  // Warning icon with an explicit title, and above all no single-line `If ... : `
  // form, whose clause VBScript reads to the end of the line.
  assert.ok(vbs.includes(", 48, \"Trae Meta\""), "the dialog needs a title and warning icon");
  assert.equal(/Then .*:/.test(vbs), false, "no single-line If with a colon clause");
});

test("the logon entry stays silent when the executable is missing", () => {
  // The opposite choice on purpose: a modal box at every logon would be worse
  // than the silence, so the shared builder must keep MsgBox opt-in.
  const vbs = buildAutostartVbs({
    nodePath: path.join(PROJECT_ROOT, "dist", "portable", "TraeMeta.exe"),
    bundled: true,
    flags: ["--quiet"],
  });
  assert.equal(vbs.includes("MsgBox"), false, "autostart must not pop a dialog");
});

test("the cmd entry supports both source-build and portable layouts", async () => {
  const text = (await read("scripts/trae-meta.cmd")).toString("ascii");
  assert.match(text, /dist\\TraeMeta\.exe/);
  assert.match(text, /if exist "TraeMeta\.exe"/);
  assert.match(text, /"%ENHANCER_EXE%" %ARGS%/);
});

test("the installer script keeps its required UTF-8 BOM", async () => {
  const bytes = await read("scripts/win/trae-meta.iss");
  assert.equal(bytes.subarray(0, 3).equals(UTF8_BOM), true);
  assert.match(bytes.toString("utf8"), /登录时自动启动后台服务/);
});

test("the installer launches through the hidden entry point, not the executable", async () => {
  const text = (await read("scripts/win/trae-meta.iss")).toString("utf8");

  // Packaged at all: without this the shortcut points at a missing file.
  assert.ok(
    text.includes("Source: \"{#StageRoot}\\scripts\\launch-hidden.vbs\""),
    "launch-hidden.vbs must be part of the installer payload",
  );

  // Every entry that *starts* the app must go through the launcher. The bundled
  // executable is a console program, so a shortcut pointing straight at it opens
  // a console window — the defect this replaced. The "stop" entry keeps the
  // executable on purpose, so it is not matched here.
  const launching = text
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith('Name: "{group}\\{#ProductName}"') ||
        line.startsWith('Name: "{userdesktop}\\{#ProductName}"') ||
        line.startsWith('Filename: "{sys}\\wscript.exe"'),
    );
  assert.equal(launching.length, 3, "expected the two shortcuts and the post-install run");
  for (const line of launching) {
    assert.ok(line.includes("launch-hidden.vbs"), line);
    // `Filename` is what gets run and must stay the launcher; the icon is a
    // separate field and is allowed to point back at the executable.
    const target = line.match(/(?<!Icon)Filename:\s*"([^"]*)"/);
    assert.ok(target, line);
    assert.equal(target[1].includes("{#ProductExe}"), false, line);
    if (line.startsWith("Name: ")) {
      assert.ok(line.includes('IconFilename: "{app}\\{#ProductExe}"'), line);
    }
  }
});

test("the installer wizard takes its icon from the build script's /DIconFile", async () => {
  const iss = (await read("scripts/win/trae-meta.iss")).toString("utf8");
  const build = (await read("scripts/win/build-installer.js")).toString("utf8");

  // Both halves must agree: a `SetupIconFile` with no matching /D value is an
  // ISCC error, so a rename on one side has to fail here rather than at build.
  assert.match(iss, /SetupIconFile=\{#IconFile\}/);
  assert.match(build, /\/DIconFile=\$\{ICON_PATH\}/);
});

test("the installer registers the notification identity and ships its icon file", async () => {
  const iss = (await read("scripts/win/trae-meta.iss")).toString("utf8");

  // Without an explicit AppUserModelID the notification platform attributes
  // toasts heuristically, and a freshly installed icon leaks into other apps'
  // notifications. The registration and the tray host (tray.ps1) must use the
  // same ID.
  assert.match(iss, /Subkey: "SOFTWARE\\Classes\\AppUserModelId\\TraeMeta\.Tray"/);
  assert.match(iss, /ValueName: "DisplayName"/);
  // IconUri and IconResource are both written because Windows versions read
  // different value names.
  assert.match(iss, /ValueName: "IconUri"/);
  assert.match(iss, /ValueName: "IconResource"/);
  assert.match(iss, /ValueData: "\{app\}\\icon\.ico"/);
  // The identity points at an installed file, so the icon must ship.
  assert.match(iss, /Source: "\{#StageRoot\}\\icon\.ico"/);
  assert.match(iss, /Flags: uninsdeletekey/, "the registry key must go away on uninstall");
});

test("the installer refreshes the icon cache after every install", async () => {
  const iss = (await read("scripts/win/trae-meta.iss")).toString("utf8");
  // ie4uinit -show is the gentle per-user refresh: no Explorer restart, no file
  // deletion, run automatically on every machine so upgrades heal their own
  // icon cache.
  assert.match(iss, /ie4uinit\.exe/);
  assert.match(iss, /'-show'/);
});

test("the tray host pins the notification identity before creating a window", async () => {
  const ps1 = (await read("scripts/tray.ps1")).toString("ascii");

  const pinIndex = ps1.indexOf("SetCurrentProcessExplicitAppUserModelID('TraeMeta.Tray')");
  const notifyIndex = ps1.indexOf("New-Object System.Windows.Forms.NotifyIcon");
  assert.ok(pinIndex !== -1, "the tray host must pin the AppUserModelID");
  // SetCurrentProcessExplicitAppUserModelID fails once the process owns a
  // window, and NotifyIcon creates one, so the order is load-bearing.
  assert.ok(pinIndex < notifyIndex, "the AUMID must be set before the NotifyIcon is created");
});

test("the portable release archive lists its payload instead of the whole folder", async () => {
  const text = (await read("scripts/release-pack.js")).toString("utf8");

  // Archiving `.` from dist/portable sweeps in `data/` and `logs/` whenever the
  // portable build has been run in place — `data/` holds account snapshots and
  // `api-token`, so that would upload credentials to a public GitHub Release.
  // That is exactly what happened once; this keeps the explicit list from being
  // "simplified" back into a whole-folder archive.
  assert.match(text, /"-C",\s*PORTABLE_DIR,\s*\.\.\.PORTABLE_PAYLOAD/);
  assert.equal(/"-C",\s*PORTABLE_DIR,\s*"\."/.test(text), false);
  assert.match(text, /if \(!PORTABLE_PAYLOAD\.includes\(name\)\)/);
  assert.match(text, /\^\(data\|logs\)/);
});

test("release artifacts go into a per-version folder instead of the release root", async () => {
  const pack = (await read("scripts/release-pack.js")).toString("utf8");
  const publish = (await read("scripts/release-publish.js")).toString("utf8");

  // The release root used to hold the newest artifacts flat while older releases
  // sat in per-version folders, so packing the next version deleted the previous
  // one's files. Both scripts must agree on `dist/release/v<version>/` so every
  // released version keeps its own files side by side.
  assert.match(pack, /path\.join\(RELEASE_DIR, `v\$\{version\}`\)/);
  assert.match(publish, /path\.join\(RELEASE_DIR, `v\$\{version\}`/);
  assert.equal(
    /readdir\(RELEASE_DIR/.test(pack),
    false,
    "pack must not clean the shared release root",
  );
});

test("the third-party Simplified Chinese translation is not rewritten", async () => {
  const bytes = await read("scripts/win/ChineseSimplified.isl");
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    LANGUAGE_SHA256,
  );
});

test("package and runtime versions stay aligned", async () => {
  const pkg = JSON.parse((await read("package.json")).toString("utf8"));
  assert.equal(APP_VERSION, pkg.version);
});
