import { assert, t, done, M } from "./harness.mjs";
import http from "node:http";
import crypto from "node:crypto";

const { NodeWebSocket } = M;

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

done("nodews");
