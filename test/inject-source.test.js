import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INJECT_SOURCE_ASSET_KEY,
  loadInjectSource,
  renderInjectScript,
} from "../src/lib/inject-source.js";

const TEMPLATE = [
  "const base = '__API_BASE__';",
  "const token = '__API_TOKEN__';",
  "const version = '__APP_VERSION__';",
].join("\n");

test("rendering replaces every injection placeholder", () => {
  const rendered = renderInjectScript(TEMPLATE, {
    apiBase: "http://127.0.0.1:47837",
    apiToken: "abc123",
    appVersion: "1.0.0",
  });
  assert.equal(rendered.includes("__API_BASE__"), false);
  assert.equal(rendered.includes("__API_TOKEN__"), false);
  assert.equal(rendered.includes("__APP_VERSION__"), false);
  assert.match(rendered, /const base = 'http:\/\/127\.0\.0\.1:47837';/);
  assert.match(rendered, /const token = 'abc123';/);
  assert.match(rendered, /const version = '1\.0\.0';/);
});

test("rendering substitutes every occurrence, not only the first", () => {
  const rendered = renderInjectScript("__API_BASE__/a __API_BASE__/b", {
    apiBase: "http://x",
    apiToken: "t",
    appVersion: "v",
  });
  assert.equal(rendered, "http://x/a http://x/b");
});

test("rendering refuses an empty injection source", () => {
  assert.throws(() => renderInjectScript("", { apiToken: "t" }), /injection source is empty/);
  assert.throws(() => renderInjectScript("   ", { apiToken: "t" }), /injection source is empty/);
  assert.throws(() => renderInjectScript(null, { apiToken: "t" }), /injection source is empty/);
});

test("a single executable reads the injection source from its embedded asset", async () => {
  const requested = [];
  const source = await loadInjectSource({
    fallbackPath: null,
    seaApi: {
      inSea: true,
      getAsset(key, encoding) {
        requested.push([key, encoding]);
        return TEMPLATE;
      },
    },
  });
  assert.equal(source, TEMPLATE);
  assert.deepEqual(requested, [[INJECT_SOURCE_ASSET_KEY, "utf8"]]);
});

test("a single executable never falls back to the file system", async () => {
  const missingPath = path.join(os.tmpdir(), `trae-enhancer-missing-${process.pid}.js`);
  await assert.rejects(
    () =>
      loadInjectSource({
        fallbackPath: missingPath,
        seaApi: {
          inSea: true,
          getAsset() {
            throw new Error("no such asset");
          },
        },
      }),
    /embedded injection source "inject\.js" is missing/,
  );
});

test("a single executable without asset support fails loudly", async () => {
  await assert.rejects(
    () =>
      loadInjectSource({
        fallbackPath: "C:\\whatever.js",
        seaApi: { inSea: true, getAsset: null },
      }),
    /exposes no SEA assets/,
  );
});

test("source mode reads the injection script from disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-enhancer-inject-"));
  const filePath = path.join(dir, "inject.js");
  try {
    await fs.writeFile(filePath, TEMPLATE, "utf8");
    const source = await loadInjectSource({
      fallbackPath: filePath,
      seaApi: { inSea: false, getAsset: null },
    });
    assert.equal(source, TEMPLATE);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("source mode without a path fails loudly", async () => {
  await assert.rejects(
    () => loadInjectSource({ fallbackPath: null, seaApi: { inSea: false, getAsset: null } }),
    /No injection source path/,
  );
});
