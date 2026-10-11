import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALLER_DIR_NAME,
  INSTALLER_DOWNLOAD_TIMEOUT_MS,
  cleanupInstallerDirectory,
  downloadInstaller,
  installerDirectory,
  launchInstaller,
  prepareInstaller,
} from "../src/lib/app-installer.js";
import { downloadToFile } from "../src/lib/http.js";

const INSTALLER_NAME = "TraeMeta-Setup-1.4.0.exe";
const INSTALLER_URL =
  "https://github.com/alexmelt2582/TraeMeta/releases/download/v1.4.0/TraeMeta-Setup-1.4.0.exe";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function temporaryRoot(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function exists(filePath) {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

/** A loopback server, so the streaming download is exercised against real bytes. */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* -------------------------------------------------------------------------- *
 * The download primitive
 *
 * `dispatcher: null` keeps these tests off whatever proxy the machine running
 * them happens to have configured; loopback is never proxied anyway.
 * -------------------------------------------------------------------------- */

test("a download is written to disk and hashed from the bytes that arrived", async () => {
  const payload = Buffer.alloc(50000, 7);
  const root = await temporaryRoot("trae-enhancer-download");
  const destination = path.join(root, "asset.bin");

  const result = await withServer(
    (request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(payload);
    },
    (base) => downloadToFile(`${base}/asset.bin`, destination, { dispatcher: null }),
  );

  assert.equal(result.bytes, payload.length);
  assert.equal(result.sha256, sha256(payload));
  assert.deepEqual(await fs.readFile(destination), payload);
});

test("progress is reported per chunk, and never after a failure", async () => {
  const payload = Buffer.alloc(60000, 4);
  const root = await temporaryRoot("trae-enhancer-download");
  const seen = [];

  const result = await withServer(
    (request, response) => {
      response.writeHead(200, { "content-length": String(payload.length) });
      // Two writes, so the loop has to report twice rather than once at the end.
      response.write(payload.subarray(0, 30000));
      response.write(payload.subarray(30000));
      response.end();
    },
    (base) =>
      downloadToFile(`${base}/asset.bin`, path.join(root, "asset.bin"), {
        dispatcher: null,
        onProgress: (progress) => seen.push(progress),
      }),
  );

  assert.equal(result.bytes, payload.length);
  assert.ok(seen.length >= 1, "at least one progress report");
  assert.equal(seen[seen.length - 1].received, payload.length);
  // A plain `number` content length is what turns into a percentage.
  assert.equal(seen[seen.length - 1].total, payload.length);

  // A failed download must not report a completion it did not reach.
  const failed = [];
  await assert.rejects(
    () =>
      withServer(
        (request, response) => {
          response.writeHead(404);
          response.end("gone");
        },
        (base) =>
          downloadToFile(`${base}/asset.bin`, path.join(root, "other.bin"), {
            dispatcher: null,
            onProgress: (progress) => failed.push(progress),
          }),
      ),
    /HTTP 404/,
  );
  assert.deepEqual(failed, []);
});

test("a file bigger than promised is stopped mid-download and deleted", async () => {
  const root = await temporaryRoot("trae-enhancer-download");
  const destination = path.join(root, "asset.bin");

  await assert.rejects(
    () =>
      withServer(
        (request, response) => {
          response.writeHead(200);
          response.end(Buffer.alloc(4096, 1));
        },
        (base) => downloadToFile(`${base}/asset.bin`, destination, { maxBytes: 10, dispatcher: null }),
      ),
    /超过预期大小/,
  );
  // A partial installer left behind is something a later run could still execute.
  assert.equal(await exists(destination), false);
});

test("a failing response leaves no file behind", async () => {
  const root = await temporaryRoot("trae-enhancer-download");
  const destination = path.join(root, "asset.bin");

  await assert.rejects(
    () =>
      withServer(
        (request, response) => {
          response.writeHead(404);
          response.end("no such release asset");
        },
        (base) => downloadToFile(`${base}/asset.bin`, destination, { dispatcher: null }),
      ),
    /HTTP 404/,
  );
  assert.equal(await exists(destination), false);
});

test("a transport failure keeps its cause chain instead of a bare failure", async () => {
  const root = await temporaryRoot("trae-enhancer-download");
  // Bind a port and release it again, so nothing is listening on it.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  await assert.rejects(
    () =>
      downloadToFile(`http://127.0.0.1:${port}/asset.bin`, path.join(root, "asset.bin"), {
        dispatcher: null,
        timeoutMs: 5000,
      }),
    (error) => {
      assert.match(error.message, /GET http:\/\/127\.0\.0\.1:\d+\/asset\.bin 失败 → /);
      // Node hides ECONNREFUSED in `cause`; a bare message tells nobody anything.
      assert.ok(error.cause, "the transport cause is kept");
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- *
 * Where the download goes
 * -------------------------------------------------------------------------- */

test("the installer goes to the user's temp directory, never into data", () => {
  assert.equal(
    installerDirectory({ env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } }),
    path.join("C:\\Users\\x\\AppData\\Local", "Temp", INSTALLER_DIR_NAME),
  );
  // A blank variable must fall back rather than produce a relative path.
  assert.equal(
    installerDirectory({ env: { LOCALAPPDATA: "   " }, tmpdir: () => "/tmp/root" }),
    path.join("/tmp/root", INSTALLER_DIR_NAME),
  );
  assert.equal(
    installerDirectory({ env: {}, tmpdir: () => "/tmp/root" }),
    path.join("/tmp/root", INSTALLER_DIR_NAME),
  );
});

test("a leftover download is cleared on the next start", async () => {
  const root = await temporaryRoot("trae-enhancer-cleanup");
  const directory = path.join(root, INSTALLER_DIR_NAME);
  await fs.mkdir(path.join(directory, "nested"), { recursive: true });
  await fs.writeFile(path.join(directory, INSTALLER_NAME), "stale");

  assert.equal(await cleanupInstallerDirectory({ env: {}, tmpdir: () => root }), true);
  assert.equal(await exists(directory), false);
  // Nothing to clear is still a success: a silent install never leaves a file.
  assert.equal(await cleanupInstallerDirectory({ env: {}, tmpdir: () => root }), true);
});

/* -------------------------------------------------------------------------- *
 * Download, verify, run
 * -------------------------------------------------------------------------- */

/** Stands in for `downloadToFile`: what it reports is what the checks compare. */
function stubDownload(payload, reported) {
  return async (url, destPath, options) => {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, payload);
    return { bytes: payload.length, sha256: sha256(payload), url, options };
  };
}

test("a download that matches the release is kept and reported as verified", async () => {
  const payload = Buffer.alloc(2048, 3);
  const root = await temporaryRoot("trae-enhancer-install");
  const installer = {
    name: INSTALLER_NAME,
    url: INSTALLER_URL,
    size: payload.length,
    digest: sha256(payload),
  };
  const stages = [];
  let seen = null;

  const result = await downloadInstaller(installer, {
    directory: root,
    downloadImpl: async (url, destPath, options) => {
      seen = { url, destPath, options };
      return stubDownload(payload)(url, destPath, options);
    },
    onStage: (stage) => stages.push(stage),
  });

  assert.equal(result.path, path.join(root, INSTALLER_NAME));
  assert.equal(result.bytes, payload.length);
  assert.equal(result.sha256, installer.digest);
  assert.deepEqual(stages, ["downloading", "verifying"]);
  assert.equal(seen.url, INSTALLER_URL);
  // The published size is the ceiling, so an oversized asset is stopped early.
  assert.equal(seen.options.maxBytes, installer.size);
  assert.equal(seen.options.timeoutMs, INSTALLER_DOWNLOAD_TIMEOUT_MS);
  assert.equal(await exists(result.path), true);
});

test("a download of the wrong size is deleted instead of installed", async () => {
  const payload = Buffer.alloc(2048, 3);
  const root = await temporaryRoot("trae-enhancer-install");
  const installer = { name: INSTALLER_NAME, url: INSTALLER_URL, size: 4096, digest: sha256(payload) };

  await assert.rejects(
    () =>
      downloadInstaller(installer, {
        directory: root,
        downloadImpl: stubDownload(payload),
      }),
    /大小不符：应为 4096 字节，实际 2048 字节/,
  );
  assert.equal(await exists(path.join(root, INSTALLER_NAME)), false);
});

test("a download whose sha256 disagrees with the release is deleted", async () => {
  const payload = Buffer.alloc(2048, 3);
  const root = await temporaryRoot("trae-enhancer-install");
  const installer = {
    name: INSTALLER_NAME,
    url: INSTALLER_URL,
    size: payload.length,
    digest: sha256(Buffer.alloc(2048, 9)),
  };

  await assert.rejects(
    () =>
      downloadInstaller(installer, {
        directory: root,
        downloadImpl: stubDownload(payload),
      }),
    /校验失败：sha256 与发布信息不一致/,
  );
  assert.equal(await exists(path.join(root, INSTALLER_NAME)), false);
});

test("the installer is started detached, and with no switches at all", () => {
  const calls = [];
  const installerPath = "C:\\Temp\\TraeMeta-Update\\setup.exe";

  const child = launchInstaller(installerPath, {
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options, unrefd: false });
      return {
        pid: 4321,
        unref() {
          calls[calls.length - 1].unrefd = true;
        },
      };
    },
  });

  // The process object, not its pid: the caller watches it exit to tell a wizard
  // that upgraded nothing from one that is about to stop this daemon.
  assert.equal(child.pid, 4321);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, installerPath);
  // No `/VERYSILENT`: the wizard window is what the user is waiting for, and it
  // is also what turns a failure into a message box instead of a silent exit.
  assert.deepEqual(calls[0].args, []);
  // Detached is the point: the installer stops the daemon that started it.
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  // `windowsHide` is a SW_HIDE hint for the child's first window, and that window
  // is the wizard the user is waiting for. Setting it here hides the upgrade.
  assert.equal(calls[0].options.windowsHide, undefined);
  assert.equal(calls[0].unrefd, true);
});

test("download progress is reported against the published size, not the header", async () => {
  const payload = Buffer.alloc(2000, 5);
  const root = await temporaryRoot("trae-enhancer-install");
  const installer = {
    name: INSTALLER_NAME,
    url: INSTALLER_URL,
    size: payload.length,
    digest: sha256(payload),
  };
  const seen = [];

  await downloadInstaller(installer, {
    directory: root,
    // Stands in for a server that sends no content length: the total still has to
    // be the size the release promised, or the panel could never show a percent.
    downloadImpl: async (url, destPath, options) => {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, payload);
      options.onProgress({ received: 500, total: null });
      options.onProgress({ received: payload.length, total: null });
      return { bytes: payload.length, sha256: sha256(payload) };
    },
    onProgress: (progress) => seen.push(progress),
  });

  assert.deepEqual(seen, [
    { received: 500, total: payload.length },
    { received: payload.length, total: payload.length },
  ]);
});

/* -------------------------------------------------------------------------- *
 * Reuse, and what the user is told when it cannot be reused
 * -------------------------------------------------------------------------- */

test("an installer that is already on disk and still matches is not fetched twice", async () => {
  const payload = Buffer.alloc(4096, 6);
  const root = await temporaryRoot("trae-enhancer-reuse");
  const installer = {
    name: INSTALLER_NAME,
    url: INSTALLER_URL,
    size: payload.length,
    digest: sha256(payload),
  };
  // What a wizard the user closed leaves behind: the verified file, untouched.
  await fs.writeFile(path.join(root, INSTALLER_NAME), payload);
  const stages = [];
  let downloads = 0;

  const result = await prepareInstaller(installer, {
    directory: root,
    downloadImpl: async () => {
      downloads += 1;
      throw new Error("a second download should never happen here");
    },
    onStage: (stage) => stages.push(stage),
  });

  assert.equal(downloads, 0);
  assert.equal(result.reused, true);
  assert.equal(result.path, path.join(root, INSTALLER_NAME));
  assert.equal(result.sha256, installer.digest);
  // Verification still runs and is still announced: the panel has to say what is
  // happening, and "校验中" is what is actually happening.
  assert.deepEqual(stages, ["verifying"]);
});

test("a leftover that no longer matches the release is downloaded again", async () => {
  const payload = Buffer.alloc(4096, 6);
  const root = await temporaryRoot("trae-enhancer-reuse");
  const installer = {
    name: INSTALLER_NAME,
    url: INSTALLER_URL,
    size: payload.length,
    digest: sha256(payload),
  };
  // Same name, different bytes — a leftover of some other build.
  await fs.writeFile(path.join(root, INSTALLER_NAME), Buffer.alloc(payload.length, 7));
  const stages = [];

  const result = await prepareInstaller(installer, {
    directory: root,
    downloadImpl: stubDownload(payload),
    onStage: (stage) => stages.push(stage),
  });

  assert.equal(result.reused, false);
  assert.equal(result.sha256, installer.digest);
  assert.deepEqual(stages, ["downloading", "verifying"]);
  assert.deepEqual(await fs.readFile(result.path), payload);
});

test("a download that times out says so in words the user can act on", async () => {
  const root = await temporaryRoot("trae-enhancer-reuse");
  const installer = { name: INSTALLER_NAME, url: INSTALLER_URL, size: 4096, digest: sha256(Buffer.alloc(1)) };

  await assert.rejects(
    () =>
      prepareInstaller(installer, {
        directory: root,
        downloadImpl: async () => {
          // Exactly what `downloadToFile` builds: undici's body timeout arrives as
          // an ordinary error in the cause chain, not as an abort.
          const inner = new Error("Body Timeout Error");
          inner.code = "UND_ERR_BODY_TIMEOUT";
          const wrapped = new Error(
            `GET ${INSTALLER_URL} 失败 → Body Timeout Error | UND_ERR_BODY_TIMEOUT`,
            { cause: inner },
          );
          wrapped.timedOut = true;
          throw wrapped;
        },
      }),
    (error) => {
      // The raw chain stays on `message`, so the daemon log keeps the real cause.
      assert.match(error.message, /UND_ERR_BODY_TIMEOUT/);
      // The panel gets the sentence: a socket-level fact must not be the thing a
      // person is asked to interpret.
      assert.match(error.userMessage, /下载安装包超时/);
      assert.doesNotMatch(error.userMessage, /UND_ERR_BODY_TIMEOUT/);
      return true;
    },
  );
});

test("a download that could not connect is told apart from one that timed out", async () => {
  const root = await temporaryRoot("trae-enhancer-reuse");
  const installer = { name: INSTALLER_NAME, url: INSTALLER_URL, size: 4096, digest: sha256(Buffer.alloc(1)) };

  await assert.rejects(
    () =>
      prepareInstaller(installer, {
        directory: root,
        downloadImpl: async () => {
          throw new Error(`GET ${INSTALLER_URL} 失败 → fetch failed | ECONNREFUSED`);
        },
      }),
    (error) => {
      assert.match(error.userMessage, /连不上发布服务器/);
      assert.doesNotMatch(error.userMessage, /ECONNREFUSED/);
      return true;
    },
  );
});