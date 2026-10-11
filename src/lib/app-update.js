/**
 * Whether a newer release of this helper exists on GitHub.
 *
 * The check runs inside the daemon, never in the panel: TRAE's workbench enforces
 * a CSP that blocks HTTP from the injected page, so every network call has to
 * originate here. Nothing about an account or a credential is involved — this
 * only reads a public release page.
 *
 * The release payload is remote content, so it is normalised down to the handful
 * of fields the panel may render. The one address that matters is the installer
 * asset: it is what this helper downloads and then executes, so it has to be
 * named exactly, published, sized, checksummed and hosted on github.com before
 * anything touches the network. A payload that fails any of those is refused with
 * the reason attached — never downgraded to "download it anyway".
 */
import { requestJson } from "./http.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The one asset the in-app upgrade will run. */
export const INSTALLER_ASSET_PREFIX = "TraeMeta-Setup-";
const DIGEST_PREFIX = "sha256:";
const GITHUB_DOWNLOAD_PATTERN = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\//i;

/**
 * Parses `v1.2.3` / `1.2.3` into numbers.
 *
 * Returns null for anything else instead of guessing: an unparseable pair must
 * not be reported as "up to date", which is what a silent fallback would do.
 */
export function parseVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Returns -1, 0 or 1, or null when either side cannot be parsed. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/** An unparseable version is never "newer", so the panel cannot be told a lie. */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

/**
 * Picks the single asset this helper is willing to download and execute.
 *
 * Every condition is a hard gate. An asset that fails one is not silently
 * skipped in favour of the next candidate: a release that cannot prove which
 * installer is the right one is a release this helper must not upgrade from,
 * because the alternative is running an unverified executable.
 *
 * Returns `{ asset }` or `{ reason }` — the reason is what the panel shows, so it
 * has to name the missing piece rather than saying "unavailable".
 */
export function selectInstallerAsset(payload, version) {
  const expected = `${INSTALLER_ASSET_PREFIX}${version}.exe`;
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  const named = assets.filter((asset) => String(asset?.name ?? "") === expected);

  if (named.length === 0) return { reason: `这个版本没有提供 ${expected}` };
  if (named.length > 1) {
    return { reason: `这个版本有 ${named.length} 个同名的 ${expected}，无法确定该用哪一个` };
  }

  const asset = named[0];
  if (asset.state !== "uploaded") {
    return { reason: `${expected} 还没有上传完成（state=${asset.state ?? "未知"}）` };
  }

  const size = Number(asset.size);
  if (!Number.isInteger(size) || size <= 0) {
    return { reason: `${expected} 没有报告文件大小` };
  }

  const digest = typeof asset.digest === "string" ? asset.digest.trim().toLowerCase() : "";
  if (!digest.startsWith(DIGEST_PREFIX) || digest.length <= DIGEST_PREFIX.length) {
    // Without a checksum there is nothing to verify the download against, and an
    // installer that cannot be verified is one we refuse to run.
    return { reason: `${expected} 没有提供 sha256 校验值` };
  }

  const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url.trim() : "";
  if (!GITHUB_DOWNLOAD_PATTERN.test(url)) {
    return { reason: `${expected} 的下载地址不在 github.com` };
  }

  return {
    asset: {
      name: expected,
      url,
      size,
      digest: digest.slice(DIGEST_PREFIX.length),
    },
  };
}

/**
 * Reduces a GitHub release payload to what the panel renders.
 *
 * `notes` is the raw Markdown body; the panel escapes it and renders a small
 * subset, so this function only has to bound its length.
 */
export function normalizeRelease(payload, { maxNotesLength = 20000 } = {}) {
  const tag = typeof payload?.tag_name === "string" ? payload.tag_name.trim() : "";
  const version = tag.replace(/^v/i, "");
  if (!version || !parseVersion(version)) return null;

  const url = typeof payload?.html_url === "string" ? payload.html_url.trim() : "";
  if (!GITHUB_DOWNLOAD_PATTERN.test(url)) return null;

  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const publishedAt =
    typeof payload?.published_at === "string" && !Number.isNaN(Date.parse(payload.published_at))
      ? new Date(payload.published_at).toISOString()
      : null;

  const selection = selectInstallerAsset(payload, version);

  return {
    version,
    tag,
    title: name || tag,
    notes: body.slice(0, maxNotesLength),
    url,
    publishedAt,
    installer: selection.asset ?? null,
    installerError: selection.asset ? null : selection.reason,
  };
}

/**
 * Reads the newest published release.
 *
 * Failures carry the transport's own `cause` chain (see `requestJson`), because
 * on the machines this ships to an unreachable GitHub is a normal outcome and
 * the panel has to say why rather than showing an empty "no update".
 */
export async function fetchLatestRelease({
  repo,
  requestJsonImpl = requestJson,
  timeoutMs = 15000,
} = {}) {
  if (typeof repo !== "string" || !repo.trim()) {
    throw new Error("未配置 GitHub 仓库，无法检查更新");
  }
  const url = `${GITHUB_API_ORIGIN}/repos/${repo.trim()}/releases/latest`;
  const response = await requestJsonImpl(url, {
    method: "GET",
    headers: { accept: "application/vnd.github+json" },
    timeoutMs,
  });
  if (!response.ok) {
    const hint =
      response.status === 403
        ? "，可能是访问频率限制或网络被拦截"
        : response.status === 404
          ? "，请确认发布页存在"
          : "";
    throw new Error(`检查更新失败：HTTP ${response.status}${hint}`);
  }
  const release = normalizeRelease(response.json);
  if (!release) throw new Error("发布信息无法解析，已忽略这次检查结果");
  return release;
}
