import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVerificationUri,
  extractAuthCode,
  TraeOAuthManager,
} from "../src/lib/trae-oauth.js";

const context = {
  pluginVersion: "2.3.83557",
  clientId: "ono9krqynydwx5",
  machineId: "machine-id",
  deviceId: "1360520616887347",
  deviceBrand: "Windows",
  deviceType: "windows",
  osVersion: "Windows 11",
  env: "",
  appVersion: "0.1.65",
  appType: "stable",
};

test("verification URI matches Trae CN authorization parameters", () => {
  const uri = new URL(
    buildVerificationUri(
      context,
      "http://127.0.0.1:4567/authorize",
      "trace-id",
      "challenge-value",
      "https://www.trae.cn",
    ),
  );
  assert.equal(uri.origin, "https://www.trae.cn");
  assert.equal(uri.pathname, "/authorization");
  assert.equal(uri.searchParams.get("auth_from"), "trae");
  assert.equal(uri.searchParams.get("client_id"), "ono9krqynydwx5");
  assert.equal(uri.searchParams.get("redirect"), "0");
  assert.equal(uri.searchParams.get("auth_callback_url"), "http://127.0.0.1:4567/authorize");
  assert.equal(uri.searchParams.get("code_challenge_method"), "S256");
  assert.equal(uri.searchParams.get("hide_saas_login"), "true");
});

test("verification URI normalizes a login host without a scheme", () => {
  const uri = new URL(
    buildVerificationUri(
      context,
      "http://127.0.0.1:4567/authorize",
      "trace-id",
      "challenge-value",
      "www.trae.cn",
    ),
  );
  assert.equal(uri.origin, "https://www.trae.cn");
});

test("auth code callback supports plain and authCodeInfo forms", () => {
  assert.equal(extractAuthCode(new URLSearchParams({ authCode: "code-1" })), "code-1");
  assert.equal(
    extractAuthCode(
      new URLSearchParams({
        authCodeInfo: JSON.stringify({
          AuthCode: "code-2",
          ExpireAt: Date.now() + 60_000,
        }),
      }),
    ),
    "code-2",
  );
});

test("expired authCodeInfo is rejected", () => {
  assert.throws(
    () =>
      extractAuthCode(
        new URLSearchParams({
          authCodeInfo: JSON.stringify({
            AuthCode: "expired",
            ExpireAt: Date.now() - 1,
          }),
        }),
      ),
    /expired/,
  );
});

test("OAuth manager reports pending, exchanging and syncing sessions as active", () => {
  const manager = new TraeOAuthManager({
    accountStore: {},
    storagePath: "",
    exePath: "",
  });
  assert.equal(manager.isActive(), false);
  manager.sessions.set("pending", { status: "pending" });
  assert.equal(manager.isActive(), true);
  manager.sessions.set("pending", { status: "complete" });
  manager.sessions.set("exchanging", { status: "exchanging" });
  assert.equal(manager.isActive(), true);
  manager.sessions.set("exchanging", { status: "complete" });
  manager.sessions.set("syncing", { status: "syncing" });
  assert.equal(manager.isActive(), true);
  manager.sessions.clear();
  manager.sessions.set("done", { status: "complete" });
  assert.equal(manager.isActive(), false);
});

test("OAuth manager waits for the post-login account sync hook", async () => {
  let called = false;
  const manager = new TraeOAuthManager({
    accountStore: {},
    storagePath: "",
    exePath: "",
    onAccountSaved: async (account, metadata) => {
      called = true;
      assert.equal(account.id, "acct_test");
      assert.equal(metadata.source, "oauth");
    },
    logger: { log() {}, error() {} },
  });

  const result = await manager.notifyAccountSaved(
    { id: "acct_test" },
    { source: "oauth" },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(called, true);
});
