// Native zero-dependency WebSocket client for Node.js (RFC 6455 over node:https).
// Enables high-performance WebSocket connections in Node.js 18+ without external packages.

import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

export class NodeWebSocket {
  constructor(urlStr) {
    this.url = new URL(urlStr);
    this.readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
    this.binaryType = "arraybuffer";
    this._listeners = { message: [], open: [], close: [], error: [] };
    this._socket = null;
    this._connect();
  }

  addEventListener(type, fn) {
    if (this._listeners[type]) {
      this._listeners[type].push(fn);
    }
  }

  removeEventListener(type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter((cb) => cb !== fn);
    }
  }

  _emit(type, event) {
    const list = this._listeners[type] || [];
    for (const fn of [...list]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`NodeWebSocket listener error (${type}):`, err);
      }
    }
  }

  _connect() {
    const isWss = this.url.protocol === "wss:" || this.url.protocol === "https:";
    const transport = isWss ? https : http;
    const defaultPort = isWss ? 443 : 80;
    const port = this.url.port ? parseInt(this.url.port, 10) : defaultPort;
    const secKey = crypto.randomBytes(16).toString("base64");

    const req = transport.request({
      hostname: this.url.hostname,
      port,
      path: this.url.pathname + this.url.search,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": secKey,
        "Sec-WebSocket-Version": "13",
      },
    });

    req.on("upgrade", (res, socket, head) => {
      this._socket = socket;
      this.readyState = 1; // OPEN
      this._emit("open", {});

      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 2) {
          const byte1 = buffer[0];
          const byte2 = buffer[1];
          const opcode = byte1 & 0x0f;
          let payloadLen = byte2 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < offset + 2) break;
            payloadLen = buffer.readUInt16BE(offset);
            offset += 2;
          } else if (payloadLen === 127) {
            if (buffer.length < offset + 8) break;
            payloadLen = Number(buffer.readBigUInt64BE(offset));
            offset += 8;
          }

          if (buffer.length < offset + payloadLen) break;

          const payload = buffer.subarray(offset, offset + payloadLen);
          buffer = buffer.subarray(offset + payloadLen);

          if (opcode === 8) {
            // CLOSE
            this.readyState = 3;
            this._emit("close", { code: 1000, reason: "server closed" });
            socket.end();
            return;
          } else if (opcode === 9) {
            // PING -> reply PONG
            const pong = Buffer.from([0x8a, 0x00]);
            socket.write(pong);
          } else if (opcode === 1) {
            // TEXT
            this._emit("message", { data: payload.toString("utf8") });
          } else if (opcode === 2) {
            // BINARY
            const arr = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
            this._emit("message", { data: arr });
          }
        }
      });

      socket.on("close", () => {
        this.readyState = 3;
        this._emit("close", {});
      });

      socket.on("error", (err) => {
        this.readyState = 3;
        this._emit("error", err);
      });
    });

    req.on("error", (err) => {
      this.readyState = 3;
      this._emit("error", err);
    });

    req.end();
  }

  send(data) {
    if (this.readyState !== 1 || !this._socket) {
      throw new Error("WebSocket is not open");
    }

    const payload = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.from(data);

    const len = payload.length;
    let header;
    let offset = 0;

    const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array;
    const opcode = isBinary ? 0x82 : 0x81;

    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = opcode;
      header[1] = 0x80 | len; // Mask bit = 1
      offset = 2;
    } else if (len <= 65535) {
      header = Buffer.alloc(8);
      header[0] = opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      header = Buffer.alloc(14);
      header[0] = opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      offset = 10;
    }

    const mask = crypto.randomBytes(4);
    mask.copy(header, offset, 0, 4);

    const maskedPayload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }

    this._socket.write(Buffer.concat([header, maskedPayload]));
  }

  close(code = 1000, reason = "") {
    this.readyState = 2;
    if (this._socket) {
      const closeFrame = Buffer.from([0x88, 0x80, 0, 0, 0, 0]);
      try {
        this._socket.write(closeFrame);
      } catch {}
      this._socket.end();
    }
    this.readyState = 3;
  }
}
