import assert from "node:assert/strict";
import test from "node:test";

import {
  COCKPIT_IMAGE_NAMES,
  isCockpitImageName,
  normalizeImageBaseName,
  parseTasklistImageNames,
  startTraeWithCdp,
} from "../src/lib/trae-process.js";

test("an image base name loses its directory and .exe suffix", () => {
  assert.equal(
    normalizeImageBaseName("C:\\Program Files\\Cockpit Tools\\Cockpit Tools.exe"),
    "cockpit tools",
  );
  assert.equal(normalizeImageBaseName("Cockpit-Tools.EXE"), "cockpit-tools");
  assert.equal(normalizeImageBaseName("  cockpit-tools  "), "cockpit-tools");
});

test("an empty image name normalizes to an empty string", () => {
  assert.equal(normalizeImageBaseName(""), "");
  assert.equal(normalizeImageBaseName(undefined), "");
  assert.equal(normalizeImageBaseName(null), "");
});

test("every known Cockpit image name is matched", () => {
  for (const name of COCKPIT_IMAGE_NAMES) {
    assert.equal(isCockpitImageName(`${name}.exe`), true, `${name} must match`);
  }
});

test("unrelated processes are not mistaken for Cockpit", () => {
  // The TRAE match has to stay strict: a looser rule also selects the unrelated
  // "Trae CN" IDE and breaks every flow that restarts TRAE.
  assert.equal(isCockpitImageName("Trae CN.exe"), false);
  assert.equal(isCockpitImageName("Cockpit.exe"), false);
  assert.equal(isCockpitImageName("node.exe"), false);
  assert.equal(isCockpitImageName(""), false);
});

test("tasklist CSV rows are read through their quoted first column", () => {
  const stdout = [
    '"Image Name","PID","Session Name","Session#","Mem Usage"',
    '"System Idle Process","0","Services","0","8 K"',
    '"Cockpit Tools.exe","4812","Console","1","204,336 K"',
    "",
  ].join("\r\n");
  const names = parseTasklistImageNames(stdout);
  assert.deepEqual(names, ["Image Name", "System Idle Process", "Cockpit Tools.exe"]);
  assert.equal(names.filter(isCockpitImageName).length, 1);
});

test("an empty tasklist output yields no names", () => {
  assert.deepEqual(parseTasklistImageNames(""), []);
  assert.deepEqual(parseTasklistImageNames(undefined), []);
});

test("a spawn failure settles immediately instead of waiting out the CDP budget", async () => {
  const startedAt = Date.now();
  const logs = [];
  const result = await startTraeWithCdp("Z:\\definitely\\missing\\Trae CN.exe", 49152, {
    log: (message) => logs.push(message),
    waitTimeoutMs: 8000,
  });
  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 6000, "spawn failure must fail fast, not wait out the budget");
  assert.ok(logs.some((line) => line.includes("启动失败")), JSON.stringify(logs));
});

test("a process that exits during startup is reported before the CDP budget expires", async () => {
  const startedAt = Date.now();
  const logs = [];
  // node.exe rejects both injected flags outright and dies within moments —
  // exactly the "杀掉之后拉不起来" signature the switch path must not sit on
  // for the whole CDP budget before reporting a vague port timeout.
  const result = await startTraeWithCdp(process.execPath, 49153, {
    log: (message) => logs.push(message),
    waitTimeoutMs: 8000,
  });
  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 6000, "early exit must fail fast, not wait out the budget");
  assert.ok(logs.some((line) => line.includes("启动阶段退出")), JSON.stringify(logs));
});
