import assert from "node:assert/strict";
import test from "node:test";

import {
  DAEMON_ENTRY_PATH,
  LAUNCHER_ENTRY_PATH,
  SERVICE_ENTRY_PATH,
  WATCHDOG_ENTRY_PATH,
} from "../src/lib/app-paths.js";
import {
  INTERNAL_DAEMON_FLAG,
  INTERNAL_LAUNCHER_FLAG,
  INTERNAL_SERVICE_FLAG,
  INTERNAL_WATCHDOG_FLAG,
  classifyInternal,
  daemonSpec,
  launcherSpec,
  serviceBaseArgs,
  serviceSpec,
  watchdogAutostartPlan,
  watchdogSpec,
} from "../src/lib/launch-spec.js";

test("plain arguments are not mistaken for an internal switch", () => {
  assert.equal(classifyInternal(["node", "scripts/service.js", "status"]), null);
  assert.equal(classifyInternal(["TraeMeta.exe", "start"]), null);
  assert.equal(classifyInternal([]), null);
});

test("every internal switch is classified", () => {
  assert.equal(classifyInternal(["exe", "embedded", INTERNAL_DAEMON_FLAG]), "daemon");
  assert.equal(
    classifyInternal(["exe", "embedded", INTERNAL_WATCHDOG_FLAG, "--quiet"]),
    "watchdog",
  );
  assert.equal(
    classifyInternal(["exe", "embedded", INTERNAL_SERVICE_FLAG, "stop"]),
    "service",
  );
  assert.equal(classifyInternal(["exe", "embedded", INTERNAL_LAUNCHER_FLAG]), "launcher");
});

test("only the leading internal switch is honored", () => {
  assert.equal(
    classifyInternal(["exe", "embedded", INTERNAL_LAUNCHER_FLAG, INTERNAL_DAEMON_FLAG]),
    "launcher",
  );
  assert.equal(
    classifyInternal([
      "exe",
      "embedded",
      "configure",
      "--trae-exe",
      INTERNAL_DAEMON_FLAG,
    ]),
    null,
  );
  assert.equal(
    classifyInternal([
      "exe",
      "embedded",
      "start",
      INTERNAL_LAUNCHER_FLAG,
    ]),
    null,
  );
});

test("every launch spec runs the current node binary from the project root", () => {
  for (const spec of [daemonSpec(), launcherSpec(), watchdogSpec(["--quiet"])]) {
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.cwd, process.env.TRAEMETA_ENHANCER_APP_ROOT ?? spec.cwd);
    assert.equal(Array.isArray(spec.args), true);
    assert.equal(spec.args.length > 0, true);
  }
});

test("source mode spawns sibling script files", () => {
  assert.deepEqual(daemonSpec().args, [DAEMON_ENTRY_PATH]);
  assert.deepEqual(launcherSpec().args, [LAUNCHER_ENTRY_PATH]);
  assert.deepEqual(launcherSpec(["--no-restart"]).args, [
    LAUNCHER_ENTRY_PATH,
    "--no-restart",
  ]);
  assert.deepEqual(watchdogSpec(["--quiet"]).args, [WATCHDOG_ENTRY_PATH, "--quiet"]);
  assert.deepEqual(watchdogSpec().args, [WATCHDOG_ENTRY_PATH]);
});

test("the service spec keeps the command and passes through extra arguments", () => {
  assert.deepEqual(serviceSpec("stop").args, [SERVICE_ENTRY_PATH, "stop"]);
  assert.deepEqual(serviceSpec("logs", ["--tail"]).args, [SERVICE_ENTRY_PATH, "logs", "--tail"]);
  assert.deepEqual(serviceBaseArgs(), [SERVICE_ENTRY_PATH]);
});

test("the tray prefix and the service spec agree on the entry point", () => {
  const prefix = serviceBaseArgs();
  const spec = serviceSpec("status");
  assert.deepEqual(spec.args.slice(0, prefix.length), prefix);
  assert.equal(spec.args[prefix.length], "status");
});

test("a source checkout registers the watchdog script, not an internal switch", () => {
  const plan = watchdogAutostartPlan();
  assert.equal(plan.bundled, false);
  assert.equal(plan.relativeScriptPath, "scripts\\watchdog.js");
  assert.deepEqual(plan.flags, ["--quiet"]);
  assert.equal(plan.relativeScriptPath.includes(":"), false);
});
