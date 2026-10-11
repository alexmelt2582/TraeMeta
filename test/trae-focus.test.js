/**
 * Guards what a second double-click on the shortcut does.
 *
 * Until now it did nothing at all when TRAE was already running: the CDP probe
 * passed, the panel was already injected, and the launcher exited without
 * touching a window. Three files have to agree for the fix to work — the process
 * module raises the window, the launcher decides when, and the daemon carries the
 * failure message back to the panel — and none of them can be exercised here, so
 * these assertions read the sources.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const processSource = read("src/lib/trae-process.js");
const launcherSource = read("src/launcher.js");
const daemonSource = read("src/daemon.js");
const injectSource = read("src/ui/inject.js");

/** Returns the body of a top-level function in a source file. */
function bodyOf(source, signature) {
  const match = source.match(new RegExp(`${signature}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${signature} was not found`);
  return match[1];
}

/**
 * Slices a declaration out of a module by its neighbours.
 *
 * `bodyOf` cannot be used where the body embeds a multi-line here-string: the
 * embedded C# has a closing brace at column zero of its own, which is where the
 * non-greedy body match stops.
 */
function sliceBetween(source, startSignature, endSignature) {
  const start = source.indexOf(startSignature);
  assert.ok(start >= 0, `${startSignature} was not found`);
  const end = source.indexOf(endSignature, start + startSignature.length);
  assert.ok(end > start, `${endSignature} was not found after ${startSignature}`);
  return source.slice(start, end);
}

test("raising the window enumerates top-level windows instead of trusting a main-window handle", () => {
  const body = sliceBetween(
    processSource,
    "export async function focusTraeWindow(exePath)",
    "\nexport async function waitForCdp",
  );
  // PowerShell's main-window handle only reports a *visible* window, so it
  // answers 0 in exactly the case this exists for: TRAE parked in the tray. The
  // older "is TRAE running" probe may still use it — this one may not.
  assert.doesNotMatch(body, /MainWindowHandle/);
  assert.match(body, /EnumWindows\(/);
  assert.match(body, /GetWindowThreadProcessId/);
});

test("the raise distinguishes the outcomes a boolean would collapse", () => {
  for (const action of ["no-process", "no-window", "already-foreground", "restored", "shown", "focused"]) {
    assert.ok(processSource.includes(action), `the ${action} outcome is missing`);
  }
  assert.match(processSource, /IsIconic\(best\)/);
  assert.match(processSource, /ShowWindow\(best, 9\)/);
  assert.match(processSource, /ShowWindow\(best, 5\)/);
  // SetForegroundWindow is refused for a helper started from a shortcut, so the
  // switch is retried with the call that is not subject to that restriction.
  assert.match(processSource, /SetForegroundWindow\(best\)/);
  assert.match(processSource, /if \(GetForegroundWindow\(\) != best\) SwitchToThisWindow\(best, true\)/);
  // Focus can be refused outright, but z-order cannot: raising the window through
  // the topmost band and back puts it above everything without any permission.
  assert.match(processSource, /SetWindowPos\(best, HWND_TOPMOST/);
  assert.match(processSource, /SetWindowPos\(best, HWND_NOTOPMOST/);
});

test("the focus helper does not use the input-queue attach recipe", () => {
  // Microsoft documents AttachThreadInput as unreliable for taking the
  // foreground, and it was observed to fail here where the plain call succeeded.
  // Nothing may quietly reintroduce it.
  assert.doesNotMatch(processSource, /AttachThreadInput/);
  assert.doesNotMatch(processSource, /GetCurrentThreadId/);
});

test("the focus helper compiles under the Windows PowerShell 5.1 compiler", () => {
  // `out uint _` is C# 7; Add-Type on 5.1 rejects it and the whole probe fails.
  assert.doesNotMatch(processSource, /out\s+\w+\s+_[,)\s]/);
});

test("only a Chromium widget counts as the TRAE window", () => {
  // The browser process also owns IME hosts, a hint window and a GDI+ hook
  // window, and several of those carry a title. The class is what tells the real
  // window apart, and picking a helper instead would raise nothing at all.
  assert.match(processSource, /GetClassName\(handle, className, 256\)/);
  assert.match(processSource, /className\.ToString\(\) != "Chrome_WidgetWin_1"/);
});

test("a failed probe is reported, not thrown", () => {
  const body = sliceBetween(
    processSource,
    "export async function focusTraeWindow(exePath)",
    "\nexport async function waitForCdp",
  );
  assert.match(body, /action: "unavailable"/);
  assert.match(body, /catch \(error\)/);
  assert.doesNotMatch(body, /throw /);
});

test("the shortcut only raises the window when TRAE was already running", () => {
  const main = bodyOf(launcherSource, "async function main\\(\\)");
  assert.match(main, /const alreadyRunning = await isTraeCdpAvailable\(cdpPort\)/);
  // A restart or a cold start puts a window on screen on its own, so raising one
  // there would be pointless; the guard is what keeps this to the one case.
  assert.match(main, /const focusPromise = alreadyRunning \? focusTraeWindow\(exePath\) : null/);
  // The probe compiles a C# helper, so it is started before the daemon start to
  // let that cost overlap work that has to happen anyway.
  assert.ok(
    main.indexOf("const focusPromise") < main.indexOf("daemonStart = startDaemon()"),
    "the focus probe must start before the daemon start so the two waits overlap",
  );
  // On a cold start the daemon is spawned before CDP is waited on, so its own
  // startup hides inside the TRAE launch instead of being added after it.
  assert.ok(
    main.indexOf("daemonStart = startDaemon()") < main.indexOf("await waitForCdp(cdpPort)"),
    "the daemon must be started before CDP is waited on so the two run in parallel",
  );
  // Its result is only acted on after injection, because a failure is reported
  // through the panel and the panel has to exist first.
  assert.ok(
    main.indexOf("settleWindowFocus(await focusPromise") >
      main.indexOf("Failed to inject the enhancer UI"),
    "the focus result must be acted on only after the injection succeeds",
  );
});

test("a process with no window at all gets one back rather than a shrug", () => {
  const body = bodyOf(launcherSource, "async function settleWindowFocus\\(focus, exePath, dataDirPath, token\\)");
  assert.match(body, /focus\.action === "no-window"/);
  // Reuses the normal start, which carries --new-window and the single-instance
  // lock keeps it from becoming a second TRAE.
  assert.match(body, /startTraeWithCdp\(exePath, cdpPort\)/);
  // A new window is not on screen the moment the request returns, so its arrival
  // is waited for instead of sampled once: one fixed delay turned a slow start
  // into a "could not raise the window" notice while the window was already up.
  assert.match(body, /const deadline = Date\.now\(\) \+ 8000/);
  assert.match(body, /while \(Date\.now\(\) < deadline\)/);
  assert.match(body, /await delay\(700\)/);
  assert.match(body, /const retry = await focusTraeWindow\(exePath\)/);
});

test("the normal start already asks the running instance for a new window", () => {
  assert.match(processSource, /spawn\(exePath, \["--new-window", `--remote-debugging-port=\$\{port\}`\]/);
});

test("only a real failure reaches the user, and only through the panel", () => {
  const body = bodyOf(launcherSource, "async function settleWindowFocus\\(focus, exePath, dataDirPath, token\\)");
  assert.match(body, /await notifyPanel\(/);
  assert.doesNotMatch(body, /MessageBox|msg\.exe/i);
  // Nothing here may throw: a window that could not be raised is not a failed
  // launch, and reporting it as one would make the shortcut look broken.
  assert.doesNotMatch(body, /throw /);
});

test("the notice is delivered over the loopback API with the panel token", () => {
  const body = bodyOf(launcherSource, "async function notifyPanel\\(dataDirPath, token, message\\)");
  assert.match(body, /\/api\/notice/);
  assert.match(body, /x-traemeta-enhancer-token/);
  assert.match(body, /catch \(error\)/);
  // A notice that could not be delivered must not take the launch down with it.
  assert.doesNotMatch(body, /throw /);
});

test("the daemon refuses an empty notice and reports whether it landed", () => {
  const route = daemonSource.match(/pathname === "\/api\/notice"[\s\S]*?\n  \}/);
  assert.ok(route, "the notice route was not found");
  assert.match(route[0], /jsonResponse\(response, 400/);
  assert.match(route[0], /delivered/);
});

test("the panel opens itself so a notice has somewhere to be seen", () => {
  const handler = injectSource.match(/function handleNotice\(event\) \{[\s\S]*?\n  \}/);
  assert.ok(handler, "handleNotice was not found");
  // The toast lives inside the panel, which is display:flex only while open.
  assert.match(handler[0], /if \(!panel\.classList\.contains\("open"\)\) openPanel\(\)/);
  assert.ok(
    handler[0].indexOf("openPanel()") < handler[0].indexOf("showToast("),
    "the panel has to open before the toast can be seen",
  );
  assert.match(injectSource, /window\.addEventListener\(NOTICE_EVENT, handleNotice\)/);
  assert.match(injectSource, /window\.removeEventListener\(NOTICE_EVENT, handleNotice\)/);
});