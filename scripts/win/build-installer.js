#!/usr/bin/env node
/**
 * Builds the Windows installer with Inno Setup.
 *
 * The installer packages the portable build that `build-exe.js` already produced,
 * so this script never builds the executable itself; it fails with a clear
 * message when the portable output is missing or stale.
 *
 * Two encoding rules matter here:
 *   - the `.iss` contains Chinese literals, so it is forced to UTF-8 with BOM.
 *     ISCC reads a BOM-less script as ANSI and the literals turn into mojibake;
 *   - the bundled `ChineseSimplified.isl` is a third-party translation and is
 *     used exactly as published, so its bytes are only reported, never rewritten.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(path.resolve(process.argv[1]));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const PORTABLE_DIR = path.join(DIST_DIR, "portable");
const OUTPUT_DIR = path.join(DIST_DIR, "installer");
const ISS_PATH = path.join(HERE, "trae-meta.iss");
const LANGUAGE_PATH = path.join(HERE, "ChineseSimplified.isl");
const EXE_NAME = "TraeMeta.exe";
const OUTPUT_BASE = "TraeMeta-Setup";

/** Files the installer claims to package. Missing any of them is a hard error. */
const REQUIRED_PAYLOAD = [
  EXE_NAME,
  "README.md",
  path.join("scripts", "trae-meta.cmd"),
  path.join("scripts", "tray.ps1"),
];

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function log(message) {
  console.log(`[installer] ${message}`);
}

async function isFile(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readProjectVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error("package.json has no usable version");
  }
  return pkg.version.trim();
}

async function assertPayload() {
  const missing = [];
  for (const relative of REQUIRED_PAYLOAD) {
    const target = path.join(PORTABLE_DIR, relative);
    if (!(await isFile(target))) missing.push(relative);
  }
  if (missing.length) {
    throw new Error(
      [
        `便携版产物不完整，缺少：${missing.join(", ")}`,
        `目录：${PORTABLE_DIR}`,
        "请先运行：npm run build:exe",
      ].join("\n"),
    );
  }
  const stat = await fs.stat(path.join(PORTABLE_DIR, EXE_NAME));
  log(`payload: ${EXE_NAME} (${(stat.size / 1048576).toFixed(1)} MB)`);
}

async function ensureScriptBom() {
  const bytes = await fs.readFile(ISS_PATH);
  if (bytes.subarray(0, 3).equals(UTF8_BOM)) {
    log("script encoding: UTF-8 with BOM");
    return;
  }
  await fs.writeFile(ISS_PATH, Buffer.concat([UTF8_BOM, bytes]));
  log("script encoding: BOM was missing and has been added");
}

async function reportLanguageFile() {
  const bytes = await fs.readFile(LANGUAGE_PATH);
  const hasBom = bytes.subarray(0, 3).equals(UTF8_BOM);
  log(
    `language file: ChineseSimplified.isl (${bytes.length} bytes, UTF-8${hasBom ? " with BOM" : " without BOM"})`,
  );
}

async function findIscc() {
  const candidates = [
    process.env.INNO_SETUP_ISCC,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Inno Setup 6", "ISCC.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Inno Setup 6", "ISCC.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(
    [
      "找不到 Inno Setup 6 的 ISCC.exe。",
      "安装方法（免管理员，装到用户目录）：",
      '  innosetup-6.7.3.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER',
      "也可以用 INNO_SETUP_ISCC 环境变量指定 ISCC.exe 的完整路径。",
    ].join("\n"),
  );
}

async function compile(isccPath, version) {
  const args = [
    `/DStageRoot=${PORTABLE_DIR}`,
    `/DOutputDir=${OUTPUT_DIR}`,
    `/DAppVersion=${version}`,
    `/DOutputBaseFilename=${OUTPUT_BASE}`,
    ISS_PATH,
  ];
  log(`ISCC: ${isccPath}`);
  const { stdout } = await execFileAsync(isccPath, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const summary = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /successful|error|warning|Compressing|installer/i.test(line));
  for (const line of summary.slice(-8)) log(line);
}

async function verifyOutput(version) {
  const expected = path.join(OUTPUT_DIR, `${OUTPUT_BASE}-${version}.exe`);
  if (!(await isFile(expected))) {
    const listed = await fs.readdir(OUTPUT_DIR).catch(() => []);
    throw new Error(
      `安装包没有生成：${expected}\n目录现有内容：${listed.join(", ") || "(空)"}`,
    );
  }
  const stat = await fs.stat(expected);
  if (stat.size < 1024 * 1024) {
    throw new Error(`安装包体积异常（${stat.size} 字节），构建很可能失败了`);
  }
  log(`built ${path.relative(PROJECT_ROOT, expected)} (${(stat.size / 1048576).toFixed(1)} MB)`);
  return expected;
}

async function main() {
  const version = await readProjectVersion();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await assertPayload();
  await ensureScriptBom();
  await reportLanguageFile();
  const isccPath = await findIscc();
  await compile(isccPath, version);
  const artifact = await verifyOutput(version);
  log("done");
  log(`installer: ${artifact}`);
}

main().catch((error) => {
  console.error(`[installer] failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
