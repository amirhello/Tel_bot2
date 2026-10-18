import { assert, t, done, M } from "./harness.mjs";
import http from "node:http";
import crypto from "node:crypto";
import { NodeWebSocket } from "../src/nodeWs.js";

function startMockWsServer(onConnection) {
  const server = http.createServer();
  let serverSocket = null;

  server.on("upgrade", (req, socket, head) => {
    serverSocket = socket;
    const secKey = req.headers["sec-websocket-key"];
    const acceptKey = crypto
      .createHash("sha1")
      .update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    );

    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const byte1 = buf[0];
        const byte2 = buf[1];
        const fin = (byte1 & 0x80) !== 0;
        const opcode = byte1 & 0x0f;
        const isMasked = (byte2 & 0x80) !== 0;
        let len = byte2 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) break;
          len = buf.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) break;
          len = Number(buf.readBigUInt64BE(off));
          off += 8;
        }
        const maskLen = isMasked ? 4 : 0;
        if (buf.length < off + maskLen + len) break;

        let mask = null;
        if (isMasked) {
          mask = buf.subarray(off, off + 4);
          off += 4;
        }

        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) {
          for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
        }

        buf = buf.subarray(off + len);

        onConnection?.onFrame?.({ fin, opcode, isMasked, payload, socket });

        if (opcode === 8) {
          socket.end();
          return;
        }
      }
    });

    onConnection?.onOpen?.(socket);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => {
          if (serverSocket) serverSocket.destroy();
          server.close();
        },
      });
    });
  });
}

await t("NodeWebSocket class is exported", () => {
  assert.equal(typeof NodeWebSocket, "function");
});

await t("NodeWebSocket connects, sends text frame and receives response from mock HTTP upgrade server", async () => {
  let serverSocket = null;
  const receivedClientPayloads = [];

  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    serverSocket = socket;
    const secKey = req.headers["sec-websocket-key"];
    const acceptKey = crypto
      .createHash("sha1")
      .update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    );

    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const byte2 = buf[1];
        const isMasked = (byte2 & 0x80) !== 0;
        let len = byte2 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) break;
          len = buf.readUInt16BE(off);
          off += 2;
        }
        const maskLen = isMasked ? 4 : 0;
        if (buf.length < off + maskLen + len) break;

        let mask = null;
        if (isMasked) {
          mask = buf.subarray(off, off + 4);
          off += 4;
        }

        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) {
          for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
        }

        const byte1 = buf[0];
        const opcode = byte1 & 0x0f;
        if (opcode === 8) {
          socket.end();
          return;
        }

        buf = buf.subarray(off + len);
        receivedClientPayloads.push(payload.toString("utf8"));

        // Echo response back to client unmasked
        const respPayload = Buffer.from(`echo:${payload.toString("utf8")}`);
        const respFrame = Buffer.concat([
          Buffer.from([0x81, respPayload.length]),
          respPayload,
        ]);
        try { socket.write(respFrame); } catch(e) {}
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/test`);
    const messages = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 3000);
      ws.addEventListener("open", () => {
        ws.send("hello-sayyad");
      });
      ws.addEventListener("message", (ev) => {
        messages.push(ev.data);
        ws.close();
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(receivedClientPayloads.length, 1);
    assert.equal(receivedClientPayloads[0], "hello-sayyad");
    assert.equal(messages.length, 1);
    assert.equal(messages[0], "echo:hello-sayyad");
    assert.equal(ws.readyState, 3);
  } finally {
    if (serverSocket) serverSocket.destroy();
    server.close();
  }
});

await t("NodeWebSocket responds to server PING with a masked PONG carrying the exact payload (RFC 6455 5.5.3)", async () => {
  let pongReceived = null;
  const pingPayload = Buffer.from("gemini-ping-check-9876");

  const srv = await startMockWsServer({
    onOpen(socket) {
      // Send PING frame from server: opcode 9 (0x89 = FIN + opcode 9)
      const pingFrame = Buffer.concat([
        Buffer.from([0x89, pingPayload.length]),
        pingPayload,
      ]);
      socket.write(pingFrame);
    },
    onFrame({ opcode, isMasked, payload, socket }) {
      if (opcode === 0x0a) {
        // PONG received
        pongReceived = { isMasked, payload: payload.toString("utf8") };
        socket.end();
      }
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/ping-test`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for PONG")), 3000);
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(pongReceived, "server should have received a PONG frame");
    assert.equal(pongReceived.isMasked, true, "client PONG frame MUST be masked (RFC 6455 5.1)");
    assert.equal(pongReceived.payload, "gemini-ping-check-9876", "PONG payload MUST match PING payload (RFC 6455 5.5.3)");
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket reassembles fragmented text frames and handles interleaved control frames (RFC 6455 5.4)", async () => {
  const receivedMessages = [];
  let pongCount = 0;

  const srv = await startMockWsServer({
    onOpen(socket) {
      // Fragment 1: FIN=0, opcode=1 (text), payload="First "
      const part1 = Buffer.from("First ");
      socket.write(Buffer.concat([Buffer.from([0x01, part1.length]), part1]));

      // Interleaved control frame: FIN=1, opcode=9 (PING), payload="ping-mid-frag"
      const ping = Buffer.from("ping-mid-frag");
      socket.write(Buffer.concat([Buffer.from([0x89, ping.length]), ping]));

      // Fragment 2: FIN=0, opcode=0 (continuation), payload="Middle "
      const part2 = Buffer.from("Middle ");
      socket.write(Buffer.concat([Buffer.from([0x00, part2.length]), part2]));

      // Fragment 3: FIN=1, opcode=0 (continuation, final), payload="End!"
      const part3 = Buffer.from("End!");
      socket.write(Buffer.concat([Buffer.from([0x80, part3.length]), part3]));
    },
    onFrame({ opcode, payload }) {
      if (opcode === 0x0a && payload.toString("utf8") === "ping-mid-frag") {
        pongCount++;
      }
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/frag-test`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for fragmented message")), 3000);
      ws.addEventListener("message", (ev) => {
        receivedMessages.push(ev.data);
        if (receivedMessages.length === 1) {
          ws.close();
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(receivedMessages.length, 1, "Only 1 message event should be emitted when fin=true");
    assert.equal(receivedMessages[0], "First Middle End!", "Fragmented message should be fully concatenated");
    assert.equal(pongCount, 1, "Interleaved ping must be answered with pong without breaking fragment reassembly");
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket reassembles fragmented binary frames (RFC 6455 5.4)", async () => {
  const receivedMessages = [];

  const srv = await startMockWsServer({
    onOpen(socket) {
      // Fragment 1: FIN=0, opcode=2 (binary), payload=[1, 2, 3]
      socket.write(Buffer.concat([Buffer.from([0x02, 3]), Buffer.from([1, 2, 3])]));
      // Fragment 2: FIN=1, opcode=0 (continuation), payload=[4, 5, 6]
      socket.write(Buffer.concat([Buffer.from([0x80, 3]), Buffer.from([4, 5, 6])]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/frag-bin-test`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for binary message")), 3000);
      ws.addEventListener("message", (ev) => {
        receivedMessages.push(ev.data);
        ws.close();
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(receivedMessages.length, 1);
    assert.ok(receivedMessages[0] instanceof Uint8Array, "data should be a Uint8Array");
    assert.deepEqual(Array.from(receivedMessages[0]), [1, 2, 3, 4, 5, 6]);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket _sendFrame masks outgoing frames properly", async () => {
  let receivedFrame = null;
  const srv = await startMockWsServer({
    onFrame({ opcode, isMasked, payload, socket }) {
      receivedFrame = { opcode, isMasked, payload: payload.toString("utf8") };
      socket.end();
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/send-frame-test`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 3000);
      ws.addEventListener("open", () => {
        ws._sendFrame(0x01, "direct-frame");
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(receivedFrame);
    assert.equal(receivedFrame.opcode, 1);
    assert.equal(receivedFrame.isMasked, true);
    assert.equal(receivedFrame.payload, "direct-frame");
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket handles HTTP non-101 response without hanging and emits error and close", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/forbidden`);
    let errorReceived = null;
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out — WebSocket hung on non-101 response")), 2000);
      ws.addEventListener("error", (err) => {
        errorReceived = err;
      });
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
    });

    assert.ok(errorReceived, "error event should be emitted on HTTP 403");
    assert.ok(errorReceived.message.includes("403"), "error should include 403 status");
    assert.ok(closeReceived, "close event should be emitted on HTTP 403");
    assert.equal(closeReceived.wasClean, false);
    assert.equal(ws.readyState, 3);
  } finally {
    server.close();
  }
});

await t("NodeWebSocket parses server close code and reason and emits close event exactly once", async () => {
  let closeEventsCount = 0;
  let closeEventData = null;

  const srv = await startMockWsServer({
    onOpen(socket) {
      // Send close frame: opcode 8 (0x88), payload: code 1008 (2 bytes) + "policy violation"
      const reasonBuf = Buffer.from("rate-limit-exceeded", "utf8");
      const closePayload = Buffer.alloc(2 + reasonBuf.length);
      closePayload.writeUInt16BE(1008, 0);
      reasonBuf.copy(closePayload, 2);

      const frame = Buffer.concat([
        Buffer.from([0x88, closePayload.length]),
        closePayload,
      ]);
      socket.write(frame);
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/close-code-test`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 2000);
      ws.addEventListener("close", (ev) => {
        closeEventsCount++;
        closeEventData = ev;
      });
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 200);
    });

    assert.equal(closeEventsCount, 1, "close event MUST only be emitted once");
    assert.ok(closeEventData);
    assert.equal(closeEventData.code, 1008, "status code 1008 must be parsed from server payload");
    assert.equal(closeEventData.reason, "rate-limit-exceeded", "reason phrase must be parsed from server payload");
    assert.equal(ws.readyState, 3);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket close(code, reason) sends masked frame with status code and reason", async () => {
  let receivedCloseFrame = null;

  const srv = await startMockWsServer({
    onFrame({ opcode, isMasked, payload, socket }) {
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        receivedCloseFrame = { opcode, isMasked, code, reason };
        socket.end();
      }
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/client-close-test`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 2000);
      ws.addEventListener("open", () => {
        ws.close(1000, "client normal exit");
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", reject);
    });

    assert.ok(receivedCloseFrame);
    assert.equal(receivedCloseFrame.opcode, 8);
    assert.equal(receivedCloseFrame.isMasked, true, "client close frame must be masked");
    assert.equal(receivedCloseFrame.code, 1000);
    assert.equal(receivedCloseFrame.reason, "client normal exit");
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket supports addEventListener once option and on<type> property listeners", async () => {
  const srv = await startMockWsServer({
    onOpen(socket) {
      // Send 2 text messages
      const m1 = Buffer.from("msg1");
      socket.write(Buffer.concat([Buffer.from([0x81, m1.length]), m1]));
      const m2 = Buffer.from("msg2");
      socket.write(Buffer.concat([Buffer.from([0x81, m2.length]), m2]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/once-prop-test`);
    let onceCalled = 0;
    const propMessages = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 2000);
      ws.addEventListener(
        "message",
        () => {
          onceCalled++;
        },
        { once: true },
      );

      ws.onmessage = (ev) => {
        propMessages.push(ev.data);
        if (propMessages.length === 2) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      };
      ws.onerror = reject;
    });

    assert.equal(onceCalled, 1, "once listener should only be invoked once even across multiple messages");
    assert.equal(propMessages.length, 2, "onmessage property handler should receive all messages");
    assert.equal(propMessages[0], "msg1");
    assert.equal(propMessages[1], "msg2");
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket handles 64-bit extended length payload exceeding 65535 bytes (RFC 6455 5.2)", async () => {
  let receivedLen = 0;
  const largeSize = 70000;

  const srv = await startMockWsServer({
    onFrame({ opcode, isMasked, payload, socket }) {
      if (opcode === 2) {
        receivedLen = payload.length;
        // Echo back unmasked binary frame with 10-byte extended header (len 127)
        const respHeader = Buffer.alloc(10);
        respHeader[0] = 0x82; // FIN + binary
        respHeader[1] = 127;
        respHeader.writeBigUInt64BE(BigInt(payload.length), 2);
        socket.write(Buffer.concat([respHeader, payload]));
      }
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/large-frame-test`);
    const sentData = Buffer.alloc(largeSize, 0x5a);
    let echoedData = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 70KB frame")), 4000);
      ws.addEventListener("open", () => {
        ws.send(sentData);
      });
      ws.addEventListener("message", (ev) => {
        echoedData = ev.data;
        ws.close();
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", reject);
    });

    assert.equal(receivedLen, largeSize, "server should receive entire 70KB masked payload");
    assert.ok(echoedData instanceof Uint8Array, "client should receive echoed binary payload");
    assert.equal(echoedData.byteLength, largeSize, "echoed payload should be exactly 70000 bytes");
    assert.equal(echoedData[0], 0x5a);
    assert.equal(echoedData[largeSize - 1], 0x5a);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket rejects handshake when Sec-WebSocket-Accept does not match (RFC 6455 4.2.2)", async () => {
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: INVALID_ACCEPT_KEY==\r\n\r\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/bad-accept`);
    let errorReceived = null;
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 2000);
      ws.addEventListener("error", (err) => {
        errorReceived = err;
      });
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
    });

    assert.ok(errorReceived);
    assert.ok(errorReceived.message.includes("Sec-WebSocket-Accept header mismatch"));
    assert.equal(closeReceived.code, 1002);
  } finally {
    server.close();
  }
});

await t("NodeWebSocket rejects server masked frame with protocol error 1002 (RFC 6455 5.1)", async () => {
  const srv = await startMockWsServer({
    onOpen(socket) {
      // Server sends a MASKED text frame: 0x81, 0x85 (mask bit set, len 5) + mask (4 bytes) + masked payload
      const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
      const data = Buffer.from("hello");
      const maskedData = Buffer.alloc(5);
      for (let i = 0; i < 5; i++) maskedData[i] = data[i] ^ mask[i % 4];
      socket.write(Buffer.concat([Buffer.from([0x81, 0x85]), mask, maskedData]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/server-masked`);
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 1002 close")), 2000);
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {});
    });

    assert.ok(closeReceived);
    assert.equal(closeReceived.code, 1002);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket rejects new data frame before previous fragment finished with protocol error 1002 (RFC 6455 5.4)", async () => {
  const srv = await startMockWsServer({
    onOpen(socket) {
      // Fragment 1: FIN=0, opcode=1 (text), payload="First"
      const p1 = Buffer.from("First");
      socket.write(Buffer.concat([Buffer.from([0x01, p1.length]), p1]));
      // Illegal initiating frame before Fragment 1 terminates: FIN=0, opcode=1
      const p2 = Buffer.from("Second");
      socket.write(Buffer.concat([Buffer.from([0x01, p2.length]), p2]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/bad-frag`);
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 1002 close")), 2000);
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {});
    });

    assert.ok(closeReceived);
    assert.equal(closeReceived.code, 1002);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket rejects 1-byte Close frame with protocol error 1002 (RFC 6455 5.5.1)", async () => {
  const srv = await startMockWsServer({
    onOpen(socket) {
      // Close frame with 1-byte payload (invalid under RFC 6455 Section 5.5.1)
      socket.write(Buffer.from([0x88, 1, 0x03]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/1byte-close`);
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 1002 close")), 2000);
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {});
    });

    assert.ok(closeReceived);
    assert.equal(closeReceived.code, 1002);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket rejects unknown reserved opcode with protocol error 1002 (RFC 6455 5.2)", async () => {
  const srv = await startMockWsServer({
    onOpen(socket) {
      // Reserved opcode 3 (unassigned non-control)
      socket.write(Buffer.from([0x83, 2, 0x41, 0x42]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/unknown-opcode`);
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 1002 close")), 2000);
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {});
    });

    assert.ok(closeReceived);
    assert.equal(closeReceived.code, 1002);
  } finally {
    srv.close();
  }
});

await t("NodeWebSocket rejects invalid UTF-8 sequence in text frame with 1007 (RFC 6455 5.6)", async () => {
  const srv = await startMockWsServer({
    onOpen(socket) {
      // Send text frame (opcode 1) with invalid UTF-8 byte 0xFF
      socket.write(Buffer.from([0x81, 2, 0xff, 0xff]));
    },
  });

  try {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${srv.port}/invalid-utf8`);
    let closeReceived = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 1007 close")), 2000);
      ws.addEventListener("close", (ev) => {
        closeReceived = ev;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {});
    });

    assert.ok(closeReceived);
    assert.equal(closeReceived.code, 1007);
  } finally {
    srv.close();
  }
});

done("nodews");
