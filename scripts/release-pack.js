#!/usr/bin/env node
/**
 * Packs the local release: builds the portable executable and the installer,
 * then collects both artifacts into `dist/release/v<version>/`.
 *
 * The GitHub Actions workflow that used to build these artifacts is gone, so
 * this is the only place release files are produced. It runs after local
 * acceptance and before the release-notes commit, the merge and the tag.
 *
 * Every version gets its own folder and nothing outside it is touched, so the
 * earlier releases in `dist/release/` stay downloadable side by side.
 *
 * The portable folder is archived with the bundled `tar` (`-a` picks zip from
 * the extension), which is the same shape the workflow used to publish.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(path.resolve(process.argv[1]));
const PROJECT_ROOT = path.resolve(HERE, "..");

const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const PORTABLE_DIR = path.join(DIST_DIR, "portable");
const INSTALLER_DIR = path.join(DIST_DIR, "installer");
const RELEASE_DIR = path.join(DIST_DIR, "release");

const SETUP_BASE = "TraeMeta-Setup";
const PORTABLE_BASE = "TraeMeta-Portable";
const CHECKSUM_FILE = "SHA256SUMS.txt";

/** Folder holding one version's artifacts, so releases never overwrite each other. */
function versionDir(version) {
  return path.join(RELEASE_DIR, `v${version}`);
}

/**
 * Files the portable build ships, listed explicitly on purpose.
 *
 * Archiving the whole folder would sweep in `data/` and `logs/` whenever the
 * portable build has been run in place — `data/` holds account snapshots and
 * `api-token`, so that would publish credentials. The installer never had this
 * problem because its `.iss` lists files one by one; this list keeps the zip
 * honest in the same way.
 */
const PORTABLE_PAYLOAD = [
  "TraeMeta.exe",
  "README.md",
  "scripts/trae-meta.cmd",
  "scripts/tray.ps1",
  "scripts/launch-hidden.vbs",
];

function log(message) {
  console.log(`[release] ${message}`);
}

async function isFile(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function readVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) throw new Error("package.json 没有可用版本号");
  return version;
}

/** Runs one of the project's build scripts and echoes its output. */
async function runBuildScript(relativePath) {
  const scriptPath = path.join(PROJECT_ROOT, relativePath);
  log(`运行 ${relativePath}`);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const chunk of [stdout, stderr]) {
      const text = chunk.trim();
      if (text) console.log(text);
    }
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
    throw new Error(`${relativePath} 失败：\n${detail}`);
  }
}

/**
 * Rebuilds this version's folder from scratch, so a half-written artifact can
 * never be uploaded. Other versions are left untouched.
 */
async function resetVersionDir(target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}

async function archivePortable(zipPath) {
  // `-C <dir> <files>` keeps the portable folder contents at the archive root, so
  // unpacking the zip yields a ready-to-run folder rather than a nested one.
  for (const relative of PORTABLE_PAYLOAD) {
    if (!(await isFile(path.join(PORTABLE_DIR, relative)))) {
      throw new Error(`便携版产物不完整，缺少：${relative}\n先运行：npm run build:exe`);
    }
  }
  const { stdout } = await execFileAsync(
    "tar",
    ["-a", "-c", "-f", zipPath, "-C", PORTABLE_DIR, ...PORTABLE_PAYLOAD],
    { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (stdout.trim()) log(stdout.trim());
}

/** Falsifiable check: the archive must hold the payload and nothing else. */
async function verifyArchive(zipPath) {
  const { stdout } = await execFileAsync("tar", ["-t", "-f", zipPath], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  for (const entry of entries) {
    const name = entry.replace(/\/+$/, "");
    if (/^(data|logs)(\/|$)/i.test(name)) {
      throw new Error(
        `便携版压缩包里出现了 ${name}：账号快照与 api-token 绝不能进发布产物，已中止`,
      );
    }
    if (entry.endsWith("/")) continue;
    if (!PORTABLE_PAYLOAD.includes(name)) {
      throw new Error(`便携版压缩包里有非预期条目：${name}`);
    }
  }
  for (const relative of PORTABLE_PAYLOAD) {
    if (!entries.includes(relative)) {
      throw new Error(`便携版压缩包缺少：${relative}`);
    }
  }
  log(`压缩包内容校验通过：${PORTABLE_PAYLOAD.length} 个文件，无本地数据目录`);
}

async function hashFile(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertArtifact(target, label) {
  if (!(await isFile(target))) throw new Error(`${label} 不存在：${target}`);
  const stat = await fs.stat(target);
  if (stat.size < 1024 * 1024) {
    throw new Error(`${label} 体积异常（${stat.size} 字节），构建很可能失败了`);
  }
  return stat.size;
}

async function main() {
  const version = await readVersion();
  const target = versionDir(version);
  const targetLabel = path.relative(PROJECT_ROOT, target).split(path.sep).join("/");
  log(`版本 v${version}`);
  log(`产物目录 ${targetLabel}`);

  await resetVersionDir(target);

  await runBuildScript(path.join("scripts", "build-exe.js"));
  await runBuildScript(path.join("scripts", "win", "build-installer.js"));

  const setupSource = path.join(INSTALLER_DIR, `${SETUP_BASE}-${version}.exe`);
  const zipPath = path.join(target, `${PORTABLE_BASE}-${version}.zip`);
  const setupPath = path.join(target, `${SETUP_BASE}-${version}.exe`);

  await assertArtifact(setupSource, "安装包");
  await fs.copyFile(setupSource, setupPath);
  await archivePortable(zipPath);
  await verifyArchive(zipPath);

  const sizes = new Map();
  sizes.set(path.basename(setupPath), await assertArtifact(setupPath, "安装包"));
  sizes.set(path.basename(zipPath), await assertArtifact(zipPath, "便携版压缩包"));

  const lines = [];
  for (const [name, size] of sizes) {
    const digest = await hashFile(path.join(target, name));
    lines.push(`${digest}  ${name}`);
    log(`${name}  ${(size / 1048576).toFixed(1)} MB  sha256 ${digest}`);
  }
  await fs.writeFile(path.join(target, CHECKSUM_FILE), `${lines.join("\n")}\n`, "utf8");
  log(`已生成 ${targetLabel}/${CHECKSUM_FILE}`);

  const notesPath = path.join(PROJECT_ROOT, "docs", "releases", `v${version}.md`);
  if (!(await isFile(notesPath))) {
    log(`提醒：docs/releases/v${version}.md 还没有，发布前必须写好并提交`);
  }

  log(`打包完成，产物在 ${targetLabel}/`);
  log("接下来：写发布说明 → 提交 → 合并 main → 打标签 → 推送 → npm run release:publish");
}

main().catch((error) => {
  console.error(`[release] failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});