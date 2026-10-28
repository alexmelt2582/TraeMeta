import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { fetch as undiciFetch } from "undici";

import { describeErrorChain, isTimeoutError, redactUrl } from "./net-diagnostics.js";
import { getDispatcherFor } from "./proxy-runtime.js";

/**
 * Every outbound request in this daemon goes through here, which is what makes a
 * single dispatcher enough to route the whole program.
 *
 * The npm `undici` package is used rather than Node's global `fetch`: a
 * dispatcher built by npm undici cannot be handed to the built-in fetch, so the
 * two have to come from the same copy. Loopback callers keep the global fetch
 * (see `launcher.js`, `watchdog.js` and the injected panel) and never touch a
 * proxy.
 */
export async function requestJson(
  url,
  {
    method = "POST",
    headers = {},
    body,
    timeoutMs = 20000,
    dispatcher,
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const activeDispatcher = dispatcher === undefined ? getDispatcherFor(url) : dispatcher;
  try {
    const response = await undiciFetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "follow",
      ...(activeDispatcher ? { dispatcher: activeDispatcher } : {}),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Preserve non-JSON responses for callers that only need status/error metadata.
    }
    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
    };
  } catch (error) {
    /**
     * A bare `fetch failed` tells nobody anything: Node puts the real reason in
     * `error.cause`. The label keeps the method and the host and strips every
     * query value, because `did` carries an account identifier.
     */
    const label = `${method} ${redactUrl(url)}`;
    const timedOut = isTimeoutError(error);
    const wrapped = new Error(
      timedOut
        ? `${label} 超时（${timeoutMs}ms）`
        : `${label} 失败 → ${describeErrorChain(error)}`,
      { cause: error },
    );
    if (timedOut) wrapped.timedOut = true;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a remote file to disk, hashing it as it arrives.
 *
 * The companion of `requestJson`, and the only other way out of this process:
 * both resolve their dispatcher the same way, so a configured proxy cannot be
 * bypassed by the one request that fetches a binary. The digest covers exactly
 * the bytes that were written, which is what lets the caller prove the file is
 * the one the release advertised before anything runs it.
 *
 * `maxBytes` aborts a download that is already bigger than promised, so a wrong
 * or tampered asset cannot fill the disk before the check happens. A partial file
 * is deleted on every failure path: a truncated installer left in the temp
 * directory is something a later run could still execute.
 *
 * `onProgress` is called after every chunk with the bytes written so far. It is
 * an observer only — nothing it does can change the download — and it is never
 * called on a path that will not end in a written file, so a caller can report
 * progress without having to tell a failure apart from a completion.
 *
 * `signal` lets a caller cancel mid-flight (the update-cancel button). The
 * external signal aborts the same controller the timeout uses, so undici sees
 * one signal no matter who pulled the trigger; the thrown error is marked
 * `cancelled` so the caller can tell a user's decision from a transport failure.
 */
export async function downloadToFile(
  url,
  destPath,
  { headers = {}, timeoutMs = 300000, maxBytes = null, dispatcher, onProgress, signal } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const activeDispatcher = dispatcher === undefined ? getDispatcherFor(url) : dispatcher;
  const hash = createHash("sha256");
  let handle = null;
  let bytes = 0;
  let complete = false;
  try {
    const response = await undiciFetch(url, {
      method: "GET",
      headers: { accept: "application/octet-stream", ...headers },
      signal: controller.signal,
      redirect: "follow",
      /**
       * undici times every socket out on its own — 5 minutes by default — and
       * that clock used to be the one that actually killed a slow download, long
       * before the budget this function was given. The error it raises
       * (`UND_ERR_BODY_TIMEOUT`) is not an abort, so it fell through to the raw
       * chain and the panel printed it verbatim. Pinning both to `timeoutMs`
       * leaves exactly one definition of "too slow", and it is the caller's.
       */
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      ...(activeDispatcher ? { dispatcher: activeDispatcher } : {}),
    });
    if (!response.ok) throw selfDescribedError(`HTTP ${response.status}`);
    if (!response.body) throw selfDescribedError("响应没有内容");

    // A release asset served with a content length lets the caller show a real
    // percentage; without one the total stays null and it can only show bytes.
    const declared = Number(response.headers?.get?.("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : null;

    handle = await fs.open(destPath, "w");
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (maxBytes !== null && bytes > maxBytes) {
        throw selfDescribedError(`超过预期大小（已接收 ${bytes} 字节，最多 ${maxBytes} 字节）`);
      }
      hash.update(chunk);
      await handle.write(chunk);
      onProgress?.({ received: bytes, total });
    }
    complete = true;
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (signal?.aborted) {
      // 外部取消不是传输失败：不带超时/网络字样，让调用方按 cancelled 分支处理。
      const cancelled = new Error("下载已取消");
      cancelled.cancelled = true;
      throw cancelled;
    }
    // A message this function already wrote is the whole story; only a transport
    // failure needs the `cause` chain, exactly as in `requestJson`.
    if (error?.selfDescribed) throw error;
    const label = `GET ${redactUrl(url)}`;
    const timedOut = isTimeoutError(error);
    const wrapped = new Error(
      timedOut ? `${label} 超时（${timeoutMs}ms）` : `${label} 失败 → ${describeErrorChain(error)}`,
      { cause: error },
    );
    if (timedOut) wrapped.timedOut = true;
    throw wrapped;
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    clearTimeout(timer);
    if (handle) await handle.close().catch(() => {});
    if (!complete) await fs.rm(destPath, { force: true }).catch(() => {});
  }
}

function selfDescribedError(message) {
  const error = new Error(message);
  error.selfDescribed = true;
  return error;
}

export function pickPath(root, path) {
  let current = root;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

export function pickString(root, paths) {
  for (const path of paths) {
    const value = pickPath(root, path);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function pickNumber(root, paths) {
  for (const path of paths) {
    const value = pickPath(root, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return null;
}

export function safeRemoteError(response) {
  const error = response.json;
  const message =
    pickString(error, [
      ["ResponseMetadata", "Error", "Message"],
      ["error", "message"],
      ["message"],
      ["msg"],
      ["Result", "Message"],
    ]) ||
    (response.text ? `response length ${response.text.length}` : "empty response");
  return `HTTP ${response.status}: ${message}`;
}

