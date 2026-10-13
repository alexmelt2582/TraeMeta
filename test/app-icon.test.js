import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { APP_ICON_ASSET_KEY, APP_ICON_SOURCE_PATH, loadAppIcon } from "../src/lib/app-icon.js";

test("source mode reads the shipped icon from disk", async () => {
  const icon = await loadAppIcon();
  assert.ok(Buffer.isBuffer(icon));
  assert.deepEqual(icon, await fs.readFile(APP_ICON_SOURCE_PATH));
  // A valid ICO: reserved=0, type=1, at least one image. A truncated or empty
  // file would leave the tray host with a blank icon and no error.
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 1);
});

test("bundled mode reads the same icon from the SEA asset instead of disk", async () => {
  const embedded = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
  const icon = await loadAppIcon({
    fallbackPath: "Z:\\does-not-exist\\icon.ico",
    seaApi: {
      inSea: true,
      getAsset: (key) => {
        assert.equal(key, APP_ICON_ASSET_KEY);
        return embedded.buffer.slice(embedded.byteOffset, embedded.byteOffset + embedded.length);
      },
    },
  });
  assert.deepEqual(icon, embedded);
});

test("a missing embedded asset is reported instead of silently falling back to disk", async () => {
  await assert.rejects(
    () =>
      loadAppIcon({
        seaApi: {
          inSea: true,
          getAsset: () => {
            throw new Error("no such asset");
          },
        },
      }),
    /embedded application icon/,
  );
});