import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  SOURCES,
  candidateTraePaths,
  detectTraeExe,
  displayIconToExePath,
  formatNotFoundHelp,
  formatResolvedLine,
  isProductDisplayName,
  matchesProductExeName,
} from "../src/lib/trae-locate.js";

const EXE = "Trae CN.exe";
const LOCAL = path.normalize("C:\\Users\\ZHD\\AppData\\Local");
const LOCAL_EXE = path.join(LOCAL, "Programs", "Trae CN", EXE);
const D_EXE = path.normalize("D:\\Apps\\Trae CN\\" + EXE);

function fakeProbe({ files = [], processPaths = [], uninstall = [] } = {}) {
  const known = new Set(files.map((value) => path.normalize(value).toLowerCase()));
  const probed = [];
  return {
    probed,
    async isFile(candidate) {
      probed.push(path.normalize(candidate));
      return known.has(path.normalize(candidate).toLowerCase());
    },
    async runningProcessPaths() {
      return processPaths;
    },
    async uninstallEntries() {
      return uninstall;
    },
  };
}

const ENV = { LOCALAPPDATA: LOCAL, APPDATA: "C:\\Users\\ZHD\\AppData\\Roaming" };

test("a registry DisplayIcon is turned into a usable path", () => {
  assert.equal(
    displayIconToExePath('"D:\\Apps\\Trae CN\\Trae CN.exe",0'),
    path.normalize("D:\\Apps\\Trae CN\\Trae CN.exe"),
  );
  assert.equal(
    displayIconToExePath("D:\\Apps\\Trae CN.exe,0"),
    path.normalize("D:\\Apps\\Trae CN.exe"),
  );
  assert.equal(
    displayIconToExePath('"D:\\Apps\\Trae CN.exe"'),
    path.normalize("D:\\Apps\\Trae CN.exe"),
  );
  assert.equal(displayIconToExePath("D:\\Apps\\readme.txt,0"), null);
  assert.equal(displayIconToExePath(""), null);
  assert.equal(displayIconToExePath(null), null);
});

test("candidate paths cover the well known directories without duplicates", () => {
  const candidates = candidateTraePaths(ENV);
  assert.equal(candidates.includes(LOCAL_EXE), true);
  assert.equal(new Set(candidates.map((value) => value.toLowerCase())).size, candidates.length);
  for (const candidate of candidates) {
    assert.equal(path.basename(candidate), EXE);
  }
});

test("an explicit argument wins over every other source", async () => {
  const probe = fakeProbe({
    files: [D_EXE, LOCAL_EXE],
    processPaths: [LOCAL_EXE],
  });
  const result = await detectTraeExe({
    explicit: D_EXE,
    configured: LOCAL_EXE,
    env: { ...ENV, TRAEMETA_ENHANCER_TRAE_EXE: LOCAL_EXE },
    probe,
  });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "explicit");
});

test("the saved configuration is used when no argument is given", async () => {
  const probe = fakeProbe({ files: [D_EXE, LOCAL_EXE], processPaths: [LOCAL_EXE] });
  const result = await detectTraeExe({
    configured: D_EXE,
    env: { ...ENV, TRAEMETA_ENHANCER_TRAE_EXE: LOCAL_EXE },
    probe,
  });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "config");
});

test("the environment variable is used before any probing", async () => {
  const probe = fakeProbe({ files: [D_EXE], processPaths: [D_EXE] });
  const result = await detectTraeExe({
    env: { ...ENV, TRAEMETA_ENHANCER_TRAE_EXE: D_EXE },
    probe,
  });
  assert.equal(result.source, "env");
});

test("a running TRAE process is the first probed source", async () => {
  const probe = fakeProbe({ files: [D_EXE], processPaths: [D_EXE] });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "process");
});

test("the uninstall registry is used when no process is running", async () => {
  const probe = fakeProbe({
    files: [D_EXE],
    uninstall: [{ DisplayName: "Trae CN", InstallLocation: "D:\\Apps", DisplayIcon: `"${D_EXE}",0` }],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "registry");
});

test("well known directories are the last resort", async () => {
  const probe = fakeProbe({ files: [LOCAL_EXE] });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, LOCAL_EXE);
  assert.equal(result.source, "candidate");
});

test("a failure still explains every probed location", async () => {
  const probe = fakeProbe({ processPaths: ["D:\\ghost\\Trae CN.exe"] });
  const result = await detectTraeExe({
    configured: "D:\\missing\\Trae CN.exe",
    env: ENV,
    probe,
  });
  assert.equal(result.path, null);
  assert.equal(result.source, null);
  assert.equal(result.attempts.length > 1, true);
  assert.equal(result.attempts.every((attempt) => attempt.exists === false), true);
  const sources = new Set(result.attempts.map((attempt) => attempt.source));
  assert.equal(sources.has("config"), true);
  assert.equal(sources.has("process"), true);
  assert.equal(sources.has("candidate"), true);
  for (const attempt of result.attempts) {
    assert.equal(typeof SOURCES[attempt.source], "string");
  }
});

test("the same path is never probed twice", async () => {
  const probe = fakeProbe({ files: [] });
  await detectTraeExe({
    explicit: D_EXE,
    configured: D_EXE,
    env: { ...ENV, TRAEMETA_ENHANCER_TRAE_EXE: D_EXE },
    probe,
  });
  const hits = probe.probed.filter(
    (candidate) => candidate.toLowerCase() === D_EXE.toLowerCase(),
  );
  assert.equal(hits.length, 1);
});

test("probing stops as soon as a source matches", async () => {
  const probe = fakeProbe({ files: [D_EXE] });
  await detectTraeExe({ configured: D_EXE, env: ENV, probe });
  assert.equal(probe.probed.length, 1);
});

test("probing a resolved configuration never touches the process or registry", async () => {
  let processAsked = false;
  const probe = {
    async isFile() {
      return true;
    },
    async runningProcessPaths() {
      processAsked = true;
      return [];
    },
    async uninstallEntries() {
      processAsked = true;
      return [];
    },
  };
  const result = await detectTraeExe({ configured: D_EXE, env: ENV, probe });
  assert.equal(result.source, "config");
  assert.equal(processAsked, false);
});

test("exhaustive mode probes every source but keeps the same priority winner", async () => {
  const probe = fakeProbe({ files: [D_EXE, LOCAL_EXE], processPaths: [LOCAL_EXE] });
  const result = await detectTraeExe({
    configured: D_EXE,
    env: ENV,
    probe,
    exhaustive: true,
  });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "config");
  const sources = new Set(result.attempts.map((attempt) => attempt.source));
  assert.equal(sources.has("process"), true);
  assert.equal(sources.has("candidate"), true);
});

test("a registry entry for the legacy TraeWork CN workspace is ignored", async () => {
  const legacy = "C:\\Users\\ZHD\\AppData\\Local\\Programs\\TRAE SOLO CN\\TRAE SOLO CN.exe";
  const probe = fakeProbe({
    files: [legacy],
    uninstall: [
      { DisplayName: "TraeWork CN (User)", InstallLocation: "C:\\Users\\ZHD\\AppData\\Local\\Programs\\TRAE SOLO CN", DisplayIcon: `"${legacy}",0` },
    ],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, null);
  assert.equal(
    result.attempts.some((attempt) => attempt.source === "registry"),
    false,
  );
});

test("the display name is matched strictly on the merged TRAE CN product", () => {
  assert.equal(isProductDisplayName("TRAE CN (User)"), true);
  assert.equal(isProductDisplayName("Trae CN"), true);
  assert.equal(isProductDisplayName("TraeWork CN (User)"), false);
  assert.equal(isProductDisplayName("TraeCode CN (User)"), false);
  assert.equal(isProductDisplayName("TRAE SOLO CN Enhancer 1.4.0"), false);
  assert.equal(isProductDisplayName("TraeCode CN Enhancer 1.0.1"), false);
  assert.equal(isProductDisplayName("TRAE"), false);
  assert.equal(isProductDisplayName(undefined), false);
});

test("a merged TRAE CN entry on a non-default drive is found through its DisplayIcon", async () => {
  const probe = fakeProbe({
    files: [D_EXE],
    uninstall: [
      {
        DisplayName: "TRAE CN (User)",
        InstallLocation: "D:\\Apps",
        DisplayIcon: `"${D_EXE}",0`,
      },
    ],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "registry");
});

test("a TRAE CN entry without a usable DisplayIcon falls back to InstallLocation", async () => {
  const probe = fakeProbe({
    files: [D_EXE],
    uninstall: [{ DisplayName: "TRAE CN (User)", InstallLocation: "D:\\Apps\\Trae CN" }],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "registry");
});

test("a DisplayIcon naming the product exe identifies it without a product name", async () => {
  const probe = fakeProbe({
    files: [D_EXE],
    uninstall: [{ DisplayName: "Some Rebranded Build", DisplayIcon: `"${D_EXE}",0` }],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "registry");
});

test("an unrelated entry is ignored even when it lists an install location", async () => {
  const probe = fakeProbe({
    files: [D_EXE],
    uninstall: [{ DisplayName: "Some Other App", InstallLocation: "D:\\Apps" }],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, null);
  assert.equal(
    result.attempts.some((attempt) => attempt.source === "registry"),
    false,
  );
});

test("a registry DisplayIcon pointing at another executable is rejected", () => {
  assert.equal(matchesProductExeName("C:\\x\\Trae CN.exe"), true);
  assert.equal(matchesProductExeName("C:\\x\\TRAE SOLO CN.exe"), false);
  assert.equal(matchesProductExeName("C:\\x\\TraeCode CN.exe"), false);
  assert.equal(matchesProductExeName(null), false);
});

test("a genuine Trae CN registry entry is accepted", async () => {
  const probe = fakeProbe({
    files: [D_EXE],
    uninstall: [
      { DisplayName: "Trae CN", InstallLocation: "D:\\Apps", DisplayIcon: `"${D_EXE}",0` },
    ],
  });
  const result = await detectTraeExe({ env: ENV, probe });
  assert.equal(result.path, D_EXE);
  assert.equal(result.source, "registry");
});

test("the installer-facing line carries an ascii source key, never a label", () => {
  assert.equal(
    formatResolvedLine({ path: "D:\\Apps\\Trae CN.exe", source: "process" }),
    "D:\\Apps\\Trae CN.exe\tprocess",
  );
  assert.equal(formatResolvedLine({ path: null, source: null }), "");
  assert.equal(formatResolvedLine(null), "");
  assert.equal(formatResolvedLine({ path: "D:\\a.exe" }), "D:\\a.exe\t");
  const asciiOnly = formatResolvedLine({ path: "D:\\a.exe", source: "registry" });
  assert.equal(/[^\x00-\x7f]/.test(asciiOnly), false);
});

test("the not-found help lists the probes and the command that fixes it", () => {
  const help = formatNotFoundHelp({
    attempts: [{ source: "candidate", value: "C:\\x\\Trae CN.exe", exists: false }],
    dataDir: "D:\\Me\\副业\\Trae多账号协同\\data",
  });
  assert.match(help, /找不到 Trae CN/);
  assert.match(help, /configure --trae-exe/);
  assert.match(help, /config\.json/);
  assert.match(help, /C:\\x\\Trae CN\.exe/);
});
