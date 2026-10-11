import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sendRaw(socket, opcode, payload) {
  const bytes = [0x80 | opcode];
  const len = payload.length;
  if (len < 126) {
    bytes.push(len);
  } else if (len < 65536) {
    bytes.push(126, (len >> 8) & 0xff, len & 0xff);
  } else {
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(len));
    bytes[1] = 127;
    for (const byte of big) bytes.push(byte);
  }
  socket.write(Buffer.concat([Buffer.from(bytes), payload]));
}

/**
 * Adds a minimal RFC 6455 WebSocket endpoint to an existing `node:http` server.
 *
 * Trae CN's workbench ships a Content-Security-Policy that forbids
 * `connect-src http:` but explicitly allows `ws:`. An injected panel can
 * therefore never reach the loopback daemon over `fetch`, so this endpoint is
 * how the panel talks to the daemon. Only JSON text messages are interpreted:
 * each is delivered to `onJson(msg, reply)`, and the reply is serialised and
 * sent back with ph=dead. Frame masking/unmasking, close, ping and continuation
 * are handled well enough for the browser client this project ships.
 */
export function attachWebSocketJson(server, pathname, onJson) {
  server.on("upgrade", (request, socket) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== pathname) {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    let head = Buffer.alloc(0);
    let frag = Buffer.alloc(0);

    const deliver = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      onJson(msg, (reply) => {
        try {
          sendRaw(socket, 0x1, Buffer.from(JSON.stringify(reply), "utf8"));
        } catch {
          // Socket is closing; drop the reply.
        }
      });
    };

    const flushFrag = () => {
      const text = frag.toString("utf8");
      frag = Buffer.alloc(0);
      deliver(text);
    };

    socket.on("data", (chunk) => {
      head = Buffer.concat([head, chunk]);
      for (;;) {
        if (head.length < 2) return;
        const b0 = head[0];
        const b1 = head[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (head.length < 4) return;
          len = head.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (head.length < 10) return;
          len = Number(head.readBigUInt64BE(2));
          off = 10;
        }
        let mask;
        if (masked) {
          if (head.length < off + 4) return;
          mask = head.subarray(off, off + 4);
          off += 4;
        }
        if (head.length < off + len) return;
        let payload = head.subarray(off, off + len);
        head = head.subarray(off + len);
        if (masked) {
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        if (opcode === 0x8) {
          try {
            sendRaw(socket, 0x8, Buffer.from([0x03, 0xe8]));
          } catch {
            // Ignore.
          }
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          try {
            sendRaw(socket, 0xa, payload);
          } catch {
            // Ignore.
          }
          continue;
        }
        if (opcode === 0xa) continue; // pong - ignore
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          frag = Buffer.concat([frag, payload]);
          if (fin) flushFrag();
          continue;
        }
        // Unknown opcode; drop it.
      }
    });
  });
}
