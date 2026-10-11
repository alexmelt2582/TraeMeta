/**
 * Downloads, verifies and finally runs the release installer.
 *
 * This is the only part of the program that executes a file it fetched from the
 * network, so the order is fixed and total: pick the asset by exact name (see
 * `selectInstallerAsset`), stream it into the temporary directory while hashing
 * it, compare the size and the sha256 against what the release advertised, and
 * only then start it. The checksum is the entire argument for running it.
 *
 * The download never lands in `data\`: that directory holds account snapshots,
 * and an installer is neither state nor something to keep. It goes to the
 * temporary directory instead, where leftovers are also thrown away — a leftover
 * is deleted on the next daemon start, because the process that downloaded it is
 * usually killed by that very installer. Until then a leftover that still matches
 * the release is reused rather than fetched again, which is what makes retrying
 * after a closed wizard free.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadToFile } from "./http.js";
import { isTimeoutError } from "./net-diagnostics.js";

export const INSTALLER_DIR_NAME = "TraeMeta-Update";
/** Generous on purpose: the asset is tens of megabytes, a slow link is not an error. */
export const INSTALLER_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Where the download goes: the user's own temp directory, never `data\`. */
export function installerDirectory({ env = process.env, tmpdir = os.tmpdir } = {}) {
  const local = typeof env.LOCALAPPDATA === "string" ? env.LOCALAPPDATA.trim() : "";
  return local
    ? path.join(local, "Temp", INSTALLER_DIR_NAME)
    : path.join(tmpdir(), INSTALLER_DIR_NAME);
}

/**
 * Removes whatever a previous run left behind.
 *
 * Best effort on purpose: the file being deleted is usually the installer that
 * is still running, so Windows refuses and the attempt simply repeats on the
 * next start. That is why this never throws.
 */
export async function cleanupInstallerDirectory(options = {}) {
  const directory = installerDirectory(options);
  try {
    await fs.rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams the installer down and proves it is the published file.
 *
 * Both failures delete the download first, so the only path that can ever reach
 * `launchInstaller` is one that matched the release byte for byte.
 */
export async function downloadInstaller(
  installer,
  { directory, downloadImpl = downloadToFile, onStage, onProgress } = {},
) {
  const targetDirectory = directory ?? installerDirectory();
  await fs.mkdir(targetDirectory, { recursive: true });
  const destination = path.join(targetDirectory, installer.name);

  onStage?.("downloading");
  let downloaded;
  try {
    downloaded = await downloadImpl(installer.url, destination, {
      timeoutMs: INSTALLER_DOWNLOAD_TIMEOUT_MS,
      // Anything bigger than the published size is already wrong, so it is stopped
      // while it is still being written instead of after it filled the disk.
      maxBytes: installer.size,
      // The published size is the total a caller should divide by: it is the size
      // the release promised, so the percentage is right even when the server sends
      // no content length at all.
      onProgress: ({ received }) => onProgress?.({ received, total: installer.size }),
    });
  } catch (error) {
    /**
     * A transport failure is two different sentences for two different readers:
     * the panel gets a short one it can act on, and the log keeps the chain that
     * names the actual cause. `message` stays untouched and `userMessage` is
     * added, so neither reader is served the other's words.
     */
    error.userMessage = describeDownloadFailure(error);
    throw error;
  }
  const { bytes, sha256 } = downloaded;

  onStage?.("verifying");
  if (bytes !== installer.size) {
    await removeQuietly(destination);
    throw new Error(`安装包大小不符：应为 ${installer.size} 字节，实际 ${bytes} 字节，已删除下载内容`);
  }
  if (sha256 !== installer.digest) {
    await removeQuietly(destination);
    throw new Error("安装包校验失败：sha256 与发布信息不一致，已删除下载内容");
  }
  return { path: destination, bytes, sha256 };
}

/**
 * The one sentence the panel shows when a download died.
 *
 * Timeouts are said as timeouts: "body timeout" is a fact about a socket, and the
 * user's only possible response to it is to check the network or the proxy — so
 * that is what the sentence asks for. Everything else is flattened the same way,
 * with the short reason kept when the download itself wrote it (`HTTP 404`).
 */
function describeDownloadFailure(error) {
  if (isTimeoutError(error)) {
    return "下载安装包超时：网络太慢或连接中断，请检查网络或代理设置后重试。";
  }
  if (error?.selfDescribed) return `下载安装包失败：${error.message}`;
  return "下载安装包失败：连不上发布服务器，请检查网络或代理设置后重试。";
}

/**
 * Gets a verified installer ready to run, downloading only when it has to.
 *
 * A wizard the user closed did not consume the file it was started from, so the
 * verified download is still sitting in the temp directory and paying for it a
 * second time would be pure waiting. Size first — a cheap answer for the common
 * case of a leftover of a different version — and sha256 second, because the
 * whole argument for running the file is that it matches the release.
 */
export async function prepareInstaller(
  installer,
  { directory, downloadImpl = downloadToFile, verifyImpl = verifyInstallerFile, onStage, onProgress } = {},
) {
  const targetDirectory = directory ?? installerDirectory();
  const destination = path.join(targetDirectory, installer.name);
  if (await verifyImpl(destination, installer)) {
    onStage?.("verifying");
    return { path: destination, bytes: installer.size, sha256: installer.digest, reused: true };
  }
  const result = await downloadInstaller(installer, {
    directory: targetDirectory,
    downloadImpl,
    onStage,
    onProgress,
  });
  return { ...result, reused: false };
}

/**
 * Whether the file already on disk is exactly the published installer.
 *
 * Any doubt — unreadable, wrong size, unreadable midway — answers `false`, which
 * only ever costs a re-download. The opposite mistake costs a run of a file
 * nothing checked.
 */
async function verifyInstallerFile(filePath, installer) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== installer.size) return false;
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  } catch {
    return false;
  }
  return hash.digest("hex") === installer.digest;
}

/**
 * Starts the installer and returns immediately.
 *
 * No switches on purpose: the download just showed the user a progress bar, so
 * the wizard window it opens next is exactly what they are waiting for. Letting
 * Inno run its own pages also means a failure is a visible message box rather
 * than a silent exit, which is the only honest thing to do when the user is
 * watching the upgrade happen.
 *
 * Detached, because the installer stops this daemon on its way in: the process
 * that starts it does not live to see it finish, and a child that died with its
 * parent would leave the machine with the service stopped and nothing to bring
 * it back. Restoring the service is the installer's own job, see the upgrade
 * branch in `scripts/win/trae-meta.iss`.
 *
 * `windowsHide` is deliberately not set. It is a `STARTUPINFO` `SW_HIDE` hint,
 * and the installer is a GUI program whose first window is exactly the wizard we
 * are trying to show: a hidden window here would look identical to the upgrade
 * silently doing nothing. There is no console to hide either — the installer is
 * a GUI subsystem executable.
 *
 * The child process itself is returned, not just its pid: the caller has to
 * watch it exit, because a wizard that ends while the daemon is still running is
 * proof the upgrade never happened.
 */
export function launchInstaller(installerPath, { spawnImpl = spawn } = {}) {
  const child = spawnImpl(installerPath, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function removeQuietly(filePath) {
  await fs.rm(filePath, { force: true }).catch(() => {});
}