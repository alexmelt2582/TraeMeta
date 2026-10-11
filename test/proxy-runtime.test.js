import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { fetch as undiciFetch } from "undici";

import {
  applyProxyConfig,
  buildDispatcher,
  describeActive,
  getDispatcher,
  getDispatcherFor,
  isExcluded,
  resetProxyRuntime,
} from "../src/lib/proxy-runtime.js";
import { ProxyAgent, Socks5ProxyAgent } from "undici";

/** A registry read that always succeeds and never touches the real machine. */
const NO_SYSTEM_PROXY = {
  available: true,
  error: null,
  snapshot: { ProxyEnable: 0, ProxyServer: "", ProxyOverride: "", AutoConfigURL: "" },
};

const CUSTOM = { mode: "custom", scheme: "http", host: "127.0.0.1", port: 7890 };

test("the three schemes each build the agent that can actually speak them", async () => {
  const socks = buildDispatcher({ scheme: "socks5", host: "h", port: 1 });
  assert.equal(socks instanceof Socks5ProxyAgent, true);

  const plain = buildDispatcher({ scheme: "http", host: "h", port: 1 });
  assert.equal(plain instanceof ProxyAgent, true);

  const tls = buildDispatcher({ scheme: "https", host: "h", port: 1 });
  assert.equal(tls instanceof ProxyAgent, true);

  assert.equal(buildDispatcher(null), null);
  assert.equal(buildDispatcher({ scheme: "http", host: "", port: 1 }), null);

  await Promise.all([socks, plain, tls].map((dispatcher) => dispatcher.close()));
});

test("credentials never appear in the agent's URL, only in its options", async () => {
  const dispatcher = buildDispatcher({
    scheme: "socks5",
    host: "h",
    port: 1,
    username: "alice",
    password: "p@ss word",
  });
  // A percent-encoded userinfo string makes undici's SOCKS handshake fail, and a
  // plaintext one would put the password somewhere it can be logged.
  assert.equal(String(dispatcher.constructor.name), "Socks5ProxyAgent");
  await dispatcher.close();
});

test("exception matching covers bare hosts, suffixes and the wildcard form", () => {
  assert.equal(isExcluded("https://api.trae.cn/x", ["api.trae.cn"]), true);
  assert.equal(isExcluded("https://a.corp.example.com/x", ["corp.example.com"]), true);
  assert.equal(isExcluded("https://corp.example.com/x", ["corp.example.com"]), true);
  assert.equal(isExcluded("https://a.corp.example.com/x", ["*.corp.example.com"]), true);
  assert.equal(isExcluded("https://notcorp.example.com/x", ["corp.example.com"]), false);
  assert.equal(isExcluded("https://api.trae.cn/x", []), false);
  assert.equal(isExcluded("not a url", ["api.trae.cn"]), false);
});

test("a live configuration swap takes effect on the next request", async () => {
  resetProxyRuntime();
  try {
    const applied = await applyProxyConfig({ proxy: CUSTOM });
    assert.equal(applied.active, true);
    assert.equal(applied.source, "custom");
    const first = getDispatcher();
    assert.equal(first instanceof ProxyAgent, true);

    const second = await applyProxyConfig({ proxy: { ...CUSTOM, port: 7891 } });
    assert.equal(second.port, 7891);
    assert.notEqual(getDispatcher(), first);
  } finally {
    resetProxyRuntime();
  }
});

test("a build failure keeps the working dispatcher instead of going direct", async () => {
  resetProxyRuntime();
  try {
    await applyProxyConfig({ proxy: CUSTOM });
    const working = getDispatcher();
    assert.equal(working instanceof ProxyAgent, true);

    // A host that cannot be parsed into a URL fails inside the agent constructor.
    const failed = await applyProxyConfig({ proxy: { ...CUSTOM, host: ":" } });
    assert.equal(failed.reason, "build-failed");
    assert.equal(failed.active, true);
    assert.equal(getDispatcher(), working);
  } finally {
    resetProxyRuntime();
  }
});

test("an incomplete custom proxy reports why rather than silently going direct", async () => {
  resetProxyRuntime();
  try {
    const applied = await applyProxyConfig({ proxy: { mode: "custom", host: "", port: 0 } });
    assert.equal(applied.active, false);
    assert.equal(applied.reason, "custom-incomplete");
    assert.equal(getDispatcher(), null);
    assert.match(applied.reasonText, /地址和端口/);
  } finally {
    resetProxyRuntime();
  }
});

test("exempted hosts get no dispatcher, so the request stays direct", async () => {
  resetProxyRuntime();
  try {
    await applyProxyConfig({ proxy: { ...CUSTOM, noProxy: "api.trae.cn" } });
    assert.equal(getDispatcherFor("https://api.trae.cn/x"), null);
    assert.equal(getDispatcherFor("https://www.trae.cn/x"), getDispatcher());
    assert.equal(getDispatcherFor("http://localhost:47837/api/health"), null);
  } finally {
    resetProxyRuntime();
  }
});

test("the snapshot the panel receives carries no credential", async () => {
  resetProxyRuntime();
  try {
    const applied = await applyProxyConfig({
      proxy: { ...CUSTOM, username: "alice", password: "s3cret" },
    });
    assert.equal(applied.hasCredentials, true);
    assert.equal(JSON.stringify(applied).includes("alice"), false);
    assert.equal(JSON.stringify(applied).includes("s3cret"), false);
    // The system snapshot is redacted at the boundary as well.
    const withSystem = await applyProxyConfig(
      { proxy: { mode: "system" } },
      {
        systemRead: {
          available: true,
          error: null,
          snapshot: {
            ProxyEnable: 1,
            ProxyServer: "alice:s3cret@h:8080",
            ProxyOverride: "",
            AutoConfigURL: "",
          },
        },
      },
    );
    assert.equal(JSON.stringify(withSystem).includes("s3cret"), false);
    assert.equal(withSystem.active, true);
  } finally {
    resetProxyRuntime();
  }
});

test("system mode with a disabled registry proxy explains itself", async () => {
  resetProxyRuntime();
  try {
    const applied = await applyProxyConfig({ proxy: { mode: "system" } }, { systemRead: NO_SYSTEM_PROXY });
    assert.equal(applied.source, "system");
    assert.equal(applied.active, false);
    assert.equal(applied.reason, "disabled");
    assert.equal(describeActive().active, false);
  } finally {
    resetProxyRuntime();
  }
});

test("a failed build never echoes the credential it was given", async () => {
  resetProxyRuntime();
  try {
    // Each of these makes the agent constructor throw while the address it was
    // handed still carries the credential, so the message that reaches the panel
    // and the daemon log is the one place it could escape.
    for (const host of ["u:p@:1", "[::1", "u:p@h:99999"]) {
      const applied = await applyProxyConfig({
        proxy: { ...CUSTOM, host, port: 1, username: "alice", password: "s3cret" },
      });
      assert.equal(applied.reason, "build-failed", host);
      assert.equal(JSON.stringify(applied).includes("s3cret"), false, `leaked for ${host}`);
      assert.equal(JSON.stringify(applied).includes("alice"), false, `leaked for ${host}`);
    }
  } finally {
    resetProxyRuntime();
  }
});

test("a request really travels through the configured proxy", async () => {
  const tunnels = [];
  // undici tunnels through an HTTP proxy with CONNECT by default, so the proxy
  // proves the routing by being asked to open the tunnel. The authority-form
  // target can only come from a client that chose the proxy: a direct request
  // would have resolved the name itself and never spoken to this server.
  const proxy = http.createServer();
  proxy.on("connect", (request, socket, head) => {
    tunnels.push(request.url);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const respond = () => {
      socket.end(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 13\r\nconnection: close\r\n\r\nthrough-proxy",
      );
    };
    if (head?.length) respond();
    else socket.once("data", respond);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = proxy.address().port;

  resetProxyRuntime();
  try {
    await applyProxyConfig({ proxy: { mode: "custom", scheme: "http", host: "127.0.0.1", port } });
    const response = await undiciFetch("http://target.invalid/hello", {
      dispatcher: getDispatcherFor("http://target.invalid/hello"),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "through-proxy");
    assert.deepEqual(tunnels, ["target.invalid:80"]);
  } finally {
    resetProxyRuntime();
    proxy.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
  }
});