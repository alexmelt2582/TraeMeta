import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GITHUB_API_ORIGIN,
  compareVersions,
  fetchLatestRelease,
  isNewerVersion,
  normalizeRelease,
  parseVersion,
  selectInstallerAsset,
} from "../src/lib/app-update.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const daemonSource = read("src/daemon.js");
const injectSource = read("src/ui/inject.js");

const RELEASE = {
  tag_name: "v1.2.0",
  name: "v1.2.0",
  html_url: "https://github.com/alexmelt2582/TraeMeta/releases/tag/v1.2.0",
  published_at: "2026-09-25T02:00:00Z",
  body: "## 本次更新\n\n- 支持检查新版本\n",
};

const INSTALLER_ASSET = {
  name: "TraeMeta-Setup-1.2.0.exe",
  state: "uploaded",
  size: 23829760,
  digest: "sha256:5e41d960e52560712f63e1ecaa1d45e2ed0cd798bc40ccb68ae47a85fb3b27ee",
  browser_download_url:
    "https://github.com/alexmelt2582/TraeMeta/releases/download/v1.2.0/TraeMeta-Setup-1.2.0.exe",
};

test("only a three part version is parsed", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion(" v1.2.3 "), [1, 2, 3]);
  assert.deepEqual(parseVersion("v1.2.3-beta.1"), [1, 2, 3]);
  for (const value of ["1.2", "1.2.3.4", "latest", "", null, undefined, {}, 42]) {
    assert.equal(parseVersion(value), null);
  }
});

test("an unparseable version is never reported as newer", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.1.9", "1.2.0"), -1);
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  // A silent false here would show "已是最新" for a version nobody could read.
  assert.equal(compareVersions("nightly", "1.2.0"), null);
  assert.equal(compareVersions("1.2.0", "nightly"), null);
  assert.equal(isNewerVersion("nightly", "1.2.0"), false);
  assert.equal(isNewerVersion("1.2.0", "nightly"), false);
  assert.equal(isNewerVersion("1.2.0", "1.1.1"), true);
  assert.equal(isNewerVersion("1.1.1", "1.2.0"), false);
});

test("a release payload is reduced to the fields the panel renders", () => {
  assert.deepEqual(normalizeRelease({ ...RELEASE, assets: [INSTALLER_ASSET] }), {
    version: "1.2.0",
    tag: "v1.2.0",
    title: "v1.2.0",
    notes: RELEASE.body,
    url: RELEASE.html_url,
    publishedAt: "2026-09-25T02:00:00.000Z",
    installer: {
      name: "TraeMeta-Setup-1.2.0.exe",
      url: INSTALLER_ASSET.browser_download_url,
      size: 23829760,
      digest: "5e41d960e52560712f63e1ecaa1d45e2ed0cd798bc40ccb68ae47a85fb3b27ee",
    },
    installerError: null,
  });
});

test("a release without a downloadable installer is still reported, with the reason", () => {
  // The version has to reach the panel even when it cannot be installed: telling
  // the user "no update" about a release that exists would be a lie.
  const release = normalizeRelease({ ...RELEASE, assets: [] });
  assert.equal(release.version, "1.2.0");
  assert.equal(release.installer, null);
  assert.match(release.installerError, /没有提供 TraeMeta-Setup-1\.2\.0\.exe/);
});

test("the installer asset has to be the exact name for this version", () => {
  const renamed = { ...INSTALLER_ASSET, name: "TraeMeta-Setup-1.1.0.exe" };
  const selection = selectInstallerAsset({ assets: [renamed] }, "1.2.0");
  assert.equal(selection.asset, undefined);
  assert.match(selection.reason, /没有提供/);
});

test("an asset that is not fully uploaded is refused", () => {
  const selection = selectInstallerAsset(
    { assets: [{ ...INSTALLER_ASSET, state: "starter" }] },
    "1.2.0",
  );
  assert.equal(selection.asset, undefined);
  assert.match(selection.reason, /还没有上传完成/);
});

test("an asset without a sha256 digest is refused instead of downloaded unverified", () => {
  // This is the whole safety argument for running the file: no digest, no install.
  for (const digest of [undefined, null, "", "sha256:", "md5:abc", "abc"]) {
    const selection = selectInstallerAsset(
      { assets: [{ ...INSTALLER_ASSET, digest }] },
      "1.2.0",
    );
    assert.equal(selection.asset, undefined, String(digest));
    assert.match(selection.reason, /没有提供 sha256 校验值/, String(digest));
  }
});

test("an asset with a missing or impossible size is refused", () => {
  for (const size of [0, -1, "many", undefined, 1.5]) {
    const selection = selectInstallerAsset({ assets: [{ ...INSTALLER_ASSET, size }] }, "1.2.0");
    assert.equal(selection.asset, undefined, String(size));
    assert.match(selection.reason, /没有报告文件大小/, String(size));
  }
});

test("two assets with the same name are refused rather than guessed between", () => {
  const selection = selectInstallerAsset(
    { assets: [INSTALLER_ASSET, { ...INSTALLER_ASSET, size: 1 }] },
    "1.2.0",
  );
  assert.equal(selection.asset, undefined);
  assert.match(selection.reason, /无法确定该用哪一个/);
});

test("an installer hosted anywhere but github.com is refused", () => {
  for (const url of [
    "https://example.com/x.exe",
    "http://github.com/alexmelt2582/TraeMeta/releases/download/v1.2.0/x.exe",
    "file:///C:/Windows/System32/calc.exe",
  ]) {
    const selection = selectInstallerAsset(
      { assets: [{ ...INSTALLER_ASSET, browser_download_url: url }] },
      "1.2.0",
    );
    assert.equal(selection.asset, undefined, url);
    assert.match(selection.reason, /不在 github\.com/, url);
  }
});

test("a digest is compared case-insensitively and stripped of its prefix", () => {
  const selection = selectInstallerAsset(
    { assets: [{ ...INSTALLER_ASSET, digest: "SHA256:ABCDEF" }] },
    "1.2.0",
  );
  assert.equal(selection.asset.digest, "abcdef");
});

test("a payload without a usable version or address is rejected", () => {
  assert.equal(normalizeRelease(null), null);
  assert.equal(normalizeRelease({}), null);
  assert.equal(normalizeRelease({ ...RELEASE, tag_name: "nightly" }), null);
  assert.equal(normalizeRelease({ ...RELEASE, html_url: "" }), null);
});

test("the release address must be a github.com release page", () => {
  // The release page is the identity the panel shows for a version, so a tampered
  // payload must not be able to make this helper claim it came from anywhere else.
  const rejected = [
    "https://example.com/alexmelt2582/TraeMeta/releases/tag/v1.2.0",
    "http://github.com/alexmelt2582/TraeMeta/releases/tag/v1.2.0",
    "https://github.com/alexmelt2582",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
  ];
  for (const url of rejected) {
    assert.equal(normalizeRelease({ ...RELEASE, html_url: url }), null, url);
  }
});

test("long release notes are bounded instead of streamed whole", () => {
  const notes = normalizeRelease({ ...RELEASE, body: "x".repeat(5000) }, { maxNotesLength: 100 });
  assert.equal(notes.notes.length, 100);
});

test("an unreadable publish date becomes null rather than an invalid date", () => {
  assert.equal(normalizeRelease({ ...RELEASE, published_at: "not a date" }).publishedAt, null);
  assert.equal(normalizeRelease({ ...RELEASE, published_at: undefined }).publishedAt, null);
});

test("the latest release is read from the repository's own endpoint", async () => {
  const calls = [];
  const release = await fetchLatestRelease({
    repo: "alexmelt2582/TraeMeta",
    requestJsonImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: RELEASE };
    },
  });
  assert.equal(release.version, "1.2.0");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GITHUB_API_ORIGIN}/repos/alexmelt2582/TraeMeta/releases/latest`);
  // The default of `requestJson` is POST, so a GET has to be asked for explicitly.
  assert.equal(calls[0].options.method, "GET");
});

test("an HTTP failure keeps a usable reason instead of returning no update", async () => {
  await assert.rejects(
    () =>
      fetchLatestRelease({
        repo: "alexmelt2582/TraeMeta",
        requestJsonImpl: async () => ({ ok: false, status: 403, json: null }),
      }),
    /HTTP 403.*频率限制/,
  );
  await assert.rejects(
    () =>
      fetchLatestRelease({
        repo: "alexmelt2582/TraeMeta",
        requestJsonImpl: async () => ({ ok: false, status: 500, json: null }),
      }),
    /HTTP 500/,
  );
});

test("a payload that cannot be parsed fails the check rather than reporting the latest", async () => {
  await assert.rejects(
    () =>
      fetchLatestRelease({
        repo: "alexmelt2582/TraeMeta",
        requestJsonImpl: async () => ({ ok: true, status: 200, json: { tag_name: "nightly" } }),
      }),
    /无法解析/,
  );
});

test("an unset repository is refused before any request is made", async () => {
  let called = false;
  await assert.rejects(
    () =>
      fetchLatestRelease({
        repo: "",
        requestJsonImpl: async () => {
          called = true;
          return { ok: true, status: 200, json: RELEASE };
        },
      }),
    /未配置 GitHub 仓库/,
  );
  assert.equal(called, false);
});

test("a failed update check never puts the address on the panel", () => {
  // `requestJson` writes its failures as `GET <url> 超时（15000ms）` or
  // `GET <url> 失败 → <cause chain>`, both of which name an internal endpoint and
  // the machine's own transport. The panel is a product surface and gets neither:
  // every failed check reads the same there, and the log keeps the chain.
  const body = daemonSource.match(/async function checkForAppUpdate\([\s\S]*?\n\}/);
  assert.ok(body, "checkForAppUpdate was not found");
  assert.match(body[0], /error: "网络连接失败",/);
  // Nothing else may be assigned to `error`: a fallback to the raw message would
  // put the address straight back on the panel.
  assert.doesNotMatch(body[0], /error:\s*(?:panelError|message)/);
  // The full message still has to land somewhere, or a real failure becomes
  // unfalsifiable — it goes to the daemon log and only there.
  assert.match(body[0], /console\.warn\(`\[update\] check failed: \$\{message\}`\)/);
});

test("the panel prints the update error it was given and no address of its own", () => {
  // Whatever the daemon put in `error` is what the panel prints, so the sentence
  // arrives as-is. The address has no other way in: the panel must not render
  // `repo` or any github.com link of its own.
  assert.match(injectSource, /上次检查失败：\$\{update\.error\}/);
  assert.doesNotMatch(injectSource, /\.repo\b/);
  assert.doesNotMatch(injectSource, /github\.com/);
  assert.doesNotMatch(injectSource, /latest\?\.url|latest\.url\b/);
});
