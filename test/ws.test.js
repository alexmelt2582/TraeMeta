import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { attachWebSocketJson } from "../src/lib/ws.js";

/**
 * A stand-in for the `net.Socket` handed to the upgrade handler: enough surface
 * for the endpoint to register its listeners and write the handshake.
 */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.write = () => true;
  socket.destroy = () => {};
  return socket;
}

test("the upgrade socket swallows errors instead of crashing the daemon", () => {
  const server = new EventEmitter();
  attachWebSocketJson(server, "/panel", () => {});

  const socket = fakeSocket();
  server.emit("upgrade", { url: "/panel", headers: {} }, socket);

  // An account switch force-kills the renderer, which tears this socket down and
  // makes Node emit ECONNRESET. With no listener that is an uncaughtException,
  // and the daemon's handler exits the process — which is the crash this guards.
  assert.ok(socket.listenerCount("error") >= 1);
  assert.doesNotThrow(() => socket.emit("error", new Error("read ECONNRESET")));
});

test("an upgrade on another path still attaches the error guard", () => {
  const server = new EventEmitter();
  attachWebSocketJson(server, "/panel", () => {});

  const socket = fakeSocket();
  server.emit("upgrade", { url: "/somewhere-else", headers: {} }, socket);

  assert.ok(socket.listenerCount("error") >= 1);
  assert.doesNotThrow(() => socket.emit("error", new Error("ECONNRESET")));
});