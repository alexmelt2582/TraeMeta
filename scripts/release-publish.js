#!/usr/bin/env node
/**
 * Publishes the already-packed release to GitHub.
 *
 * GitHub Actions used to create the release; it is gone, so this script is the
 * only publish path. Every gate exists because a published release is public
 * and hard to undo:
 *   - the release notes must exist, so the description ships with the tag;
 *   - tracked files must be committed, so the tag points at reviewed code;
 *   - the local tag must point at HEAD, so the uploaded artifacts describe the
 *     revision being released;
 *   - that tag must already exist on origin with the same commit, so the
 *     release cannot be attached to a stale or moved tag.
 *
 * `--dry-run` runs every gate and prints the `gh` command without creating
 * anything.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describeErrorChain, stripProxyEnv } from "../src/lib/net-diagnostics.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(path.resolve(process.argv[1]));
const PROJECT_ROOT = path.resolve(HERE, "..");

const RELEASE_DIR = path.join(PROJECT_ROOT, "dist", "release");
const SETUP_BASE = "TraeMeta-Setup";
const PORTABLE_BASE = "TraeMeta-Portable";
const CHECKSUM_FILE = "SHA256SUMS.txt";

const DRY_RUN = process.argv.includes("--dry-run");

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

/** Runs git/gh directly, with ambient proxy controls removed as everywhere else. */
async function run(command, args) {
  try {
    return await execFileAsync(command, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      windowsHide: true,
      env: stripProxyEnv(process.env),
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout].filter(Boolean).join("\n").trim();
    const chain = describeErrorChain(error);
    throw new Error(`${command} ${args.join(" ")} 失败：${detail || chain}`);
  }
}

async function readVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) throw new Error("package.json 没有可用版本号");
  return version;
}

async function assertNotes(notesPath) {
  if (!(await isFile(notesPath))) {
    throw new Error(`缺少发布说明：${notesPath}\n先编写并提交该文件，再打标签`);
  }
  const text = (await fs.readFile(notesPath, "utf8")).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error(`发布说明是空的：${notesPath}`);
  log(`发布说明：docs/releases/${path.basename(notesPath)}`);
}

async function assertArtifacts(artifacts) {
  for (const target of artifacts) {
    if (!(await isFile(target))) {
      throw new Error(`缺少产物：${target}\n先运行：npm run release:pack`);
    }
  }
  log(`产物：${artifacts.map((target) => path.basename(target)).join(", ")}`);
}

async function assertTrackedFilesCommitted() {
  // Untracked scratch files cannot change what the tag points at, so they are
  // deliberately not part of this gate.
  const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (stdout.trim()) {
    throw new Error(`已跟踪文件还有未提交改动，先提交再发布：\n${stdout.trim()}`);
  }
  log("已跟踪文件无未提交改动");
}

async function assertTagExists(tag) {
  try {
    await run("git", ["rev-parse", "--verify", `refs/tags/${tag}`]);
  } catch {
    throw new Error(`本地没有标签 ${tag}，先执行：git tag -a ${tag} -m "Release ${tag}"`);
  }
  log(`本地标签 ${tag} 存在`);
}

async function assertTagIsTheReleasedCommit(tag) {
  const { stdout: head } = await run("git", ["rev-parse", "HEAD"]);
  const { stdout: tagCommit } = await run("git", ["rev-parse", `${tag}^{commit}`]);
  if (head.trim() !== tagCommit.trim()) {
    throw new Error(
      `标签 ${tag} 不指向当前 HEAD，产物与将要发布的提交不一致\n` +
        `请切到该标签对应的提交（合并后的 main）再发布`,
    );
  }
  log(`标签 ${tag} 指向当前 HEAD`);
}

/**
 * Compares tag *objects*, not commits: `ls-remote` only reports the peeled
 * `^{}` line when no explicit ref pattern is given, so resolving commits here
 * would compare an annotated tag's object id against a commit id and block a
 * perfectly good release.
 */
async function assertTagPushedAndMatching(tag) {
  const { stdout } = await run("git", ["ls-remote", "origin", `refs/tags/${tag}`]);
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().endsWith(`refs/tags/${tag}`));
  if (!line) {
    throw new Error(`origin 上还没有标签 ${tag}，先执行 git push origin ${tag}`);
  }
  const remoteSha = line.split(/\s+/)[0];
  const { stdout: localSha } = await run("git", ["rev-parse", `refs/tags/${tag}`]);
  if (remoteSha !== localSha.trim()) {
    throw new Error(
      `origin 上的 ${tag}（${remoteSha}）与本地（${localSha.trim()}）不是同一个标签对象\n` +
        `先确认远端标签指向的提交，再决定是否重推`,
    );
  }
  log(`origin 上的 ${tag} 与本地是同一个标签对象`);
}

async function assertGhReady() {
  try {
    await run("gh", ["auth", "status"]);
  } catch (error) {
    throw new Error(`gh 不可用或未登录，先执行 gh auth login：\n${error.message}`);
  }
  log("gh 已登录");
}

async function assertReleaseAbsent(tag) {
  try {
    await run("gh", ["release", "view", tag, "--json", "tagName"]);
  } catch (error) {
    // "not found" is the expected state; anything else (auth, network) is not.
    if (/not found|404/i.test(error.message)) return;
    throw error;
  }
  throw new Error(
    `Release ${tag} 已存在，本脚本不覆盖已有发布\n` +
      `确需重做时先执行：gh release delete ${tag} --yes`,
  );
}

async function main() {
  const version = await readVersion();
  const tag = `v${version}`;
  log(`版本 ${tag}${DRY_RUN ? "（--dry-run，不会创建 Release）" : ""}`);

  const notesPath = path.join(PROJECT_ROOT, "docs", "releases", `${tag}.md`);
  // Artifacts live in the folder `npm run release:pack` wrote for this version;
  // gh names the uploaded assets after each file's basename.
  const artifacts = [
    path.join(RELEASE_DIR, `v${version}`, `${SETUP_BASE}-${version}.exe`),
    path.join(RELEASE_DIR, `v${version}`, `${PORTABLE_BASE}-${version}.zip`),
    path.join(RELEASE_DIR, `v${version}`, CHECKSUM_FILE),
  ];

  await assertNotes(notesPath);
  await assertArtifacts(artifacts);
  await assertTrackedFilesCommitted();
  await assertTagExists(tag);
  await assertTagIsTheReleasedCommit(tag);
  await assertTagPushedAndMatching(tag);
  await assertGhReady();
  await assertReleaseAbsent(tag);

  const args = [
    "release",
    "create",
    tag,
    "--title",
    tag,
    "--notes-file",
    notesPath,
    "--verify-tag",
    ...artifacts,
  ];
  if (DRY_RUN) {
    log(`检查全部通过，将要执行：gh ${args.join(" ")}`);
    return;
  }
  const { stdout } = await run("gh", args);
  log("发布完成");
  if (stdout.trim()) log(stdout.trim());
}

main().catch((error) => {
  console.error(`[release] failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});