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
    this.fragments = [];
    this.fragOpcode = 0;
    this._closedEmitted = false;
    this._connect();
  }

  addEventListener(type, fn, options) {
    if (!this._listeners[type] || typeof fn !== "function") return;
    if (options && options.once) {
      const onceWrapper = (event) => {
        this.removeEventListener(type, onceWrapper);
        fn(event);
      };
      onceWrapper._original = fn;
      this._listeners[type].push(onceWrapper);
    } else {
      this._listeners[type].push(fn);
    }
  }

  removeEventListener(type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter(
        (cb) => cb !== fn && cb._original !== fn,
      );
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
    const propHandler = this[`on${type}`];
    if (typeof propHandler === "function") {
      try {
        propHandler(event);
      } catch (err) {
        console.error(`NodeWebSocket property handler error (on${type}):`, err);
      }
    }
  }

  _emitClose(event = {}) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = 3;
    this.fragments = [];
    this.fragOpcode = 0;
    this._emit("close", {
      code: event.code ?? 1000,
      reason: event.reason ?? "",
      wasClean: event.wasClean ?? (event.code === 1000),
    });
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

    this._req = req;

    // Handle non-101 responses (e.g. HTTP 403 Forbidden, 429 Too Many Requests, 404, 500)
    req.on("response", (res) => {
      res.resume(); // Drain and discard
      res.on("end", () => {
        try { req.destroy(); } catch {}
      });
      const msg = `Unexpected server response: ${res.statusCode} ${res.statusMessage || ""}`.trim();
      const err = new Error(msg);
      this._emit("error", err);
      this._emitClose({ code: 1006, reason: msg, wasClean: false });
    });

    req.on("upgrade", (res, socket, head) => {
      const expectedAccept = crypto
        .createHash("sha1")
        .update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      const actualAccept = res.headers["sec-websocket-accept"];
      if (actualAccept !== expectedAccept) {
        const err = new Error("Sec-WebSocket-Accept header mismatch or missing");
        this._emit("error", err);
        this._emitClose({ code: 1002, reason: err.message, wasClean: false });
        socket.destroy();
        return;
      }

      if (this.readyState === 2 || this.readyState === 3) {
        socket.destroy();
        return;
      }

      this._socket = socket;

      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

      const processFrames = () => {
        while (buffer.length >= 2) {
          const byte1 = buffer[0];
          const byte2 = buffer[1];
          const fin = (byte1 & 0x80) !== 0;
          const opcode = byte1 & 0x0f;
          let payloadLen = byte2 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < offset + 2) break;
            payloadLen = buffer.readUInt16BE(offset);
            offset += 2;
          } else if (payloadLen === 127) {
            if (buffer.length < offset + 8) break;
            const bigLen = buffer.readBigUInt64BE(offset);
            if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
              this._emit("error", new Error("Payload length exceeds safe integer limit"));
              socket.destroy();
              return;
            }
            payloadLen = Number(bigLen);
            offset += 8;
          }

          // RFC 6455 Section 5.1: A server MUST NOT mask any frames that it sends to the client.
          const isMasked = (byte2 & 0x80) !== 0;
          if (isMasked) {
            const err = new Error("Protocol error: server frame MUST NOT be masked (RFC 6455 Section 5.1)");
            this._emit("error", err);
            this.close(1002, "Protocol error: masked frame from server");
            return;
          }

          if (payloadLen > 32 * 1024 * 1024) {
            const err = new Error("Message too big: payload exceeds 32MB limit");
            this._emit("error", err);
            this.close(1009, "Message too big");
            return;
          }

          if (buffer.length < offset + payloadLen) break;

          const payload = buffer.subarray(offset, offset + payloadLen);
          buffer = buffer.subarray(offset + payloadLen);
          if (buffer.length === 0) buffer = Buffer.alloc(0);

          // Control frames validation (RFC 6455 5.5: must not be fragmented and payload <= 125)
          if (opcode >= 8 && (!fin || payloadLen > 125)) {
            const err = new Error("Protocol error: fragmented or oversized control frame");
            this._emit("error", err);
            this.close(1002, "Protocol error");
            return;
          }

          if (opcode === 8) {
            // CLOSE frame from server (RFC 6455 Section 5.5.1)
            if (payloadLen === 1) {
              const err = new Error("Protocol error: close frame with 1-byte payload");
              this._emit("error", err);
              this.close(1002, "Protocol error");
              return;
            }
            let code = 1000;
            let reason = "server closed";
            if (payload.length >= 2) {
              code = payload.readUInt16BE(0);
              if (code < 1000 || (code >= 1004 && code <= 1006) || code === 1015 || (code >= 1016 && code <= 2999) || code >= 5000) {
                const err = new Error(`Protocol error: invalid close code ${code}`);
                this._emit("error", err);
                this.close(1002, "Protocol error");
                return;
              }
              if (payload.length > 2) {
                try {
                  reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
                } catch {
                  const err = new Error("Protocol error: close reason is not valid UTF-8");
                  this._emit("error", err);
                  this.close(1002, "Protocol error");
                  return;
                }
              } else {
                reason = "";
              }
            }
            // Reply with close frame if not already closing
            if (this.readyState === 1) {
              this.readyState = 2;
              try {
                const echoBuf = Buffer.alloc(2);
                echoBuf.writeUInt16BE(code, 0);
                this._sendFrame(0x08, echoBuf);
              } catch {}
            }
            socket.end();
            this._emitClose({ code, reason, wasClean: true });
            return;
          } else if (opcode === 9) {
            // PING -> reply masked PONG containing exact incoming payload (RFC 6455 5.5.3)
            try {
              this._sendFrame(0x0a, payload);
            } catch {}
          } else if (opcode === 10) {
            // PONG -> keepalive response, ignore
          } else if (opcode === 1 || opcode === 2 || opcode === 0) {
            // Fragmentation support (RFC 6455 Section 5.4)
            if (opcode !== 0) {
              if (this.fragOpcode !== 0) {
                const err = new Error("Protocol error: new message started before previous fragment finished");
                this._emit("error", err);
                this.close(1002, "Protocol error");
                return;
              }
              this.fragOpcode = opcode;
              this.fragments = [Buffer.from(payload)];
            } else {
              if (!this.fragOpcode) {
                // Continuation frame without prior initiating frame
                const err = new Error("Protocol error: unexpected continuation frame");
                this._emit("error", err);
                this.close(1002, "Protocol error");
                return;
              }
              this.fragments.push(Buffer.from(payload));
            }

            const totalAccum = this.fragments.reduce((sum, f) => sum + f.length, 0);
            if (totalAccum > 32 * 1024 * 1024) {
              const err = new Error("Message too big: fragmented message exceeds 32MB limit");
              this._emit("error", err);
              this.close(1009, "Message too big");
              return;
            }

            if (fin) {
              const fullPayload = Buffer.concat(this.fragments);
              const finalOpcode = this.fragOpcode;
              this.fragments = [];
              this.fragOpcode = 0;

              if (finalOpcode === 1) {
                // TEXT (RFC 6455 Section 5.6)
                let text;
                try {
                  text = new TextDecoder("utf-8", { fatal: true }).decode(fullPayload);
                } catch {
                  const err = new Error("Protocol error: invalid UTF-8 in text frame");
                  this._emit("error", err);
                  this.close(1007, "Invalid UTF-8");
                  return;
                }
                this._emit("message", { data: text });
              } else if (finalOpcode === 2) {
                // BINARY
                const arr = new Uint8Array(fullPayload);
                this._emit("message", { data: arr });
              }
            }
          } else {
            // Reserved / unknown opcode (RFC 6455 Section 5.2)
            const err = new Error(`Protocol error: unknown opcode ${opcode}`);
            this._emit("error", err);
            this.close(1002, "Protocol error");
            return;
          }
        }
      };

      // Attach socket listeners BEFORE emitting open to avoid unhandled error crash
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        processFrames();
      });

      socket.on("close", () => {
        const wasClosing = this.readyState === 2;
        this._emitClose({
          code: wasClosing ? (this._closeCode ?? 1000) : 1006,
          reason: wasClosing ? (this._closeReason ?? "") : "socket closed",
          wasClean: wasClosing,
        });
      });

      socket.on("error", (err) => {
        this._emit("error", err);
        this._emitClose({ code: 1006, reason: err.message, wasClean: false });
      });

      this.readyState = 1; // OPEN
      this._emit("open", {});

      if (buffer.length >= 2) {
        processFrames();
      }
    });

    req.on("error", (err) => {
      this._emit("error", err);
      this._emitClose({ code: 1006, reason: err.message, wasClean: false });
    });

    req.end();
  }

  _sendFrame(opcode, payloadBuffer) {
    if ((this.readyState !== 1 && (opcode !== 0x08 || this.readyState !== 2)) || !this._socket || !this._socket.writable) {
      throw new Error("WebSocket is not open");
    }

    const payload = Buffer.isBuffer(payloadBuffer)
      ? payloadBuffer
      : typeof payloadBuffer === "string"
      ? Buffer.from(payloadBuffer, "utf8")
      : payloadBuffer instanceof Uint8Array || payloadBuffer instanceof ArrayBuffer
      ? Buffer.from(payloadBuffer)
      : payloadBuffer
      ? Buffer.from(payloadBuffer)
      : Buffer.alloc(0);

    const len = payload.length;
    let header;
    let offset = 0;
    const firstByte = 0x80 | (opcode & 0x0f);

    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = firstByte;
      header[1] = 0x80 | len; // Mask bit = 1
      offset = 2;
    } else if (len <= 65535) {
      header = Buffer.alloc(8);
      header[0] = firstByte;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      header = Buffer.alloc(14);
      header[0] = firstByte;
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

  send(data) {
    if (this.readyState !== 1 || !this._socket) {
      throw new Error("WebSocket is not open");
    }

    const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer;
    const payload = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
      ? Buffer.from(data, "utf8")
      : isBinary
      ? Buffer.from(data)
      : Buffer.from(String(data ?? ""), "utf8");

    this._sendFrame(isBinary ? 0x02 : 0x01, payload);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 2 || this.readyState === 3) return;
    const wasConnecting = this.readyState === 0;
    this.readyState = 2;
    this._closeCode = code;
    this._closeReason = reason;
    if (this._req && wasConnecting) {
      try {
        this._req.destroy();
      } catch {}
    }
    if (this._socket) {
      try {
        const reasonBuf = reason ? Buffer.from(reason, "utf8") : Buffer.alloc(0);
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        if (reasonBuf.length > 0) {
          reasonBuf.copy(payload, 2);
        }
        this._sendFrame(0x08, payload);
      } catch {}
      try {
        this._socket.end();
      } catch {}
    } else {
      this._emitClose({ code, reason, wasClean: true });
    }
  }
}
